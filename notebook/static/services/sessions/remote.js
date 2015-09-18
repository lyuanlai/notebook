define([
    'jquery',
    'base/js/utils',
    'base/js/events',
    'services/kernels/serialize'
], function($, utils, events, serialize) {
    "use strict";

    var Remote = function (master_url, session_id) {
        this.events = events;

        this.ws = null;

        this.master_url = master_url || utils.get_body_data("masterUrl");
        if (!this.master_url) {
            // trailing 's' in https will become wss for secure web sockets
            this.master_url = location.protocol.replace('http', 'ws') + "//" + location.host;
        }

        this.username = "username";
        this.session_id = session_id;
        this._msg_callbacks = {};
        this._msg_queue = Promise.resolve();
        this.info_reply = {}; // remote_info_reply stored here after starting

        if (typeof(WebSocket) !== 'undefined') {
            this.WebSocket = WebSocket;
        } else if (typeof(MozWebSocket) !== 'undefined') {
            this.WebSocket = MozWebSocket;
        } else {
            alert('Your browser does not have WebSocket support, please try Chrome, Safari or Firefox ≥ 6. Firefox 4 and 5 are also supported by you have to enable WebSockets in about:config.');
        }
        
        this.bind_events();
        
        this.last_msg_id = null;
        this.last_msg_callbacks = {};

        this._autorestart_attempt = 0;
        this._reconnect_attempt = 0;
        this.reconnect_limit = 7;
    };

    /**
     * @function _get_msg
     */
    Remote.prototype._get_msg = function (msg_type, content, metadata, buffers) {
        var msg = {
            header : {
                msg_id : utils.uuid(),
                username : this.username,
                session : this.session_id,
                msg_type : msg_type,
                version : "5.0"
            },
            metadata : metadata || {},
            content : content,
            buffers : buffers || [],
            parent_header : {}
        };
        return msg;
    };

    /**
     * @function bind_events
     */
    Remote.prototype.bind_events = function () {
        var that = this;
        this.events.on('send_input_reply.Remote', function(evt, data) { 
            that.send_input_reply(data);
        });

        var record_status = function (evt, info) {
            console.log('Remote: ' + evt.type + ' (' + info + ')');
        };

        this.events.on('remote_created.Remote', record_status);
        this.events.on('remote_reconnecting.Remote', record_status);
        this.events.on('remote_connected.Remote', record_status);
        this.events.on('remote_starting.Remote', record_status);
        this.events.on('remote_restarting.Remote', record_status);
        this.events.on('remote_autorestarting.Remote', record_status);
        this.events.on('remote_interrupting.Remote', record_status);
        this.events.on('remote_disconnected.Remote', record_status);
        // these are commented out because they are triggered a lot, but can
        // be uncommented for debugging purposes
        //this.events.on('remote_idle.Remote', record_status);
        //this.events.on('remote_busy.Remote', record_status);
        this.events.on('remote_ready.Remote', record_status);
        this.events.on('remote_killed.Remote', record_status);
        this.events.on('remote_dead.Remote', record_status);

        this.events.on('remote_ready.Remote', function () {
            that._autorestart_attempt = 0;
        });
        this.events.on('remote_connected.Remote', function () {
            that._reconnect_attempt = 0;
        });
    };

    Remote.prototype._on_success = function (success) {
        /**
         * Handle a successful AJAX request by updating the remote id and
         * name from the response, and then optionally calling a provided
         * callback.
         *
         * @function _on_success
         * @param {function} success - callback
         */
        var that = this;
        return function (data, status, xhr) {
            if (data) {
                that.id = data.id;
                that.name = data.name;
            }
            if (success) {
                success(data, status, xhr);
            }
        };
    };

    Remote.prototype._on_error = function (error) {
        /**
         * Handle a failed AJAX request by logging the error message, and
         * then optionally calling a provided callback.
         *
         * @function _on_error
         * @param {function} error - callback
         */
        return function (xhr, status, err) {
            utils.log_ajax_error(xhr, status, err);
            if (error) {
                error(xhr, status, err);
            }
        };
    };

    Remote.prototype._remote_connected = function () {
        /**
         * Perform necessary tasks once the connection to the remote has
         * been established. This includes requesting information about
         * the remote.
         *
         * @function _remote_connected
         */
        this.events.trigger('remote_connected.Remote', {remote: this});
        // get remote info so we know what state the remote is in
        var that = this;
    };

    Remote.prototype._remote_dead = function () {
        /**
         * Perform necessary tasks after the remote has died. This closing
         * communication channels to the remote if they are still somehow
         * open.
         *
         * @function _remote_dead
         */
        this.stop_channel();
    };

    Remote.prototype.start_channel = function () {
        /**
         * Start the websocket channels.
         * Will stop and restart them if they already exist.
         *
         * @function start_channel
         */
        var that = this;
        this.stop_channel();
        var ws_host_url = this.master_url + '/api/sessions/' + this.session_id + '/ws';

        console.log("Starting Master WebSockets:", ws_host_url);
        
        this.ws = new this.WebSocket(ws_host_url);
        
        var already_called_onclose = false; // only alert once
        var ws_closed_early = function(evt){
            if (already_called_onclose){
                return;
            }
            already_called_onclose = true;
            if ( ! evt.wasClean ){
                // If the websocket was closed early, that could mean
                // that the remote is actually dead. Try getting
                // information about the remote from the API call --
                // if that fails, then assume the remote is dead,
                // otherwise just follow the typical websocket closed
                // protocol.
                //that.get_info(function () {
                //    that._ws_closed(ws_host_url, false);
                //}, function () {
                //    that.events.trigger('remote_dead.Remote', {remote: that});
                //    that._remote_dead();
                //});
                that._ws_closed(ws_host_url, false);
            }
        };
        var ws_closed_late = function(evt){
            if (already_called_onclose){
                return;
            }
            already_called_onclose = true;
            if ( ! evt.wasClean ){
                that._ws_closed(ws_host_url, false);
            }
        };
        var ws_error = function(evt){
            if (already_called_onclose){
                return;
            }
            already_called_onclose = true;
            that._ws_closed(ws_host_url, true);
        };

        this.ws.onopen = $.proxy(this._ws_opened, this);
        this.ws.onclose = ws_closed_early;
        this.ws.onerror = ws_error;
        // switch from early-close to late-close message after 1s
        setTimeout(function() {
            if (that.ws !== null) {
                that.ws.onclose = ws_closed_late;
            }
        }, 1000);
        this.ws.onmessage = $.proxy(this._handle_ws_message, this);
    };

    Remote.prototype._ws_opened = function (evt) {
        /**
         * Handle a websocket entering the open state,
         * signaling that the remote is connected when websocket is open.
         *
         * @function _ws_opened
         */
        if (this.is_connected()) {
            // all events ready, trigger started event.
            this._remote_connected();
        }
    };

    Remote.prototype._ws_closed = function(master_url, error) {
        /**
         * Handle a websocket entering the closed state.  If the websocket
         * was not closed due to an error, try to reconnect to the remote.
         *
         * @function _ws_closed
         * @param {string} master_url - the websocket url
         * @param {bool} error - whether the connection was closed due to an error
         */
        this.stop_channel();

        this.events.trigger('remote_disconnected.Remote', {remote: this});
        if (error) {
            console.log('Master WebSocket connection failed: ', master_url);
            this.events.trigger('remote_connection_failed.Remote', {remote: this, master_url: master_url, attempt: this._reconnect_attempt});
        }
        this._schedule_reconnect();
    };
    
    Remote.prototype._schedule_reconnect = function () {
        /**
         * function to call when remote connection is lost
         * schedules reconnect, or fires 'connection_dead' if reconnect limit is hit
         */
        if (this._reconnect_attempt < this.reconnect_limit) {
            var timeout = Math.pow(2, this._reconnect_attempt);
            console.log("Connection lost, reconnecting in " + timeout + " seconds.");
            setTimeout($.proxy(this.reconnect, this), 1e3 * timeout);
        } else {
            this.events.trigger('remote_connection_dead.Remote', {
                remote: this,
                reconnect_attempt: this._reconnect_attempt,
            });
            console.log("Failed to reconnect, giving up.");
        }
    };
    
    Remote.prototype.stop_channel = function () {
        /**
         * Close the websocket. After successful close, the value
         * in `this.ws` will be null.
         *
         * @function stop_channel
         */
        var that = this;
        var close = function () {
            if (that.ws && that.ws.readyState === WebSocket.CLOSED) {
                that.ws = null;
            }
        };
        if (this.ws !== null) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.onclose = close;
                this.ws.close();
            } else {
                close();
            }
        }
    };

    Remote.prototype.is_connected = function () {
        /**
         * Check whether there is a connection to the remote. This
         * function only returns true if websocket has been
         * created and has a state of WebSocket.OPEN.
         *
         * @function is_connected
         * @returns {bool} - whether there is a connection
         */
        // if any channel is not ready, then we're not connected
        if (this.ws === null) {
            return false;
        }
        if (this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        return true;
    };

    Remote.prototype.is_fully_disconnected = function () {
        /**
         * Check whether the connection to the remote has been completely
         * severed. This function only returns true if all channel objects
         * are null.
         *
         * @function is_fully_disconnected
         * @returns {bool} - whether the remote is fully disconnected
         */
        return (this.ws === null);
    };
    
    /**
     * @function send_input_reply
     */
    Remote.prototype.send_input_reply = function (input) {
        if (!this.is_connected()) {
            throw new Error("remote is not connected");
        }
        var content = {
            value : input
        };
        this.events.trigger('input_reply.Remote', {remote: this, content: content});
        var msg = this._get_msg("input_reply", content);
        msg.channel = 'stdin';
        this.ws.send(serialize.serialize(msg));
        return msg.header.msg_id;
    };

    Remote.prototype._handle_ws_message = function (e) {
        var that = this;
        this._msg_queue = this._msg_queue.then(function() {
            return serialize.deserialize(e.data);
        }).then(function(msg) {
            console.log(msg);
            if (msg.exec) {
                that.events.trigger('exec.Remote', {remote: that, exec: msg.exec});
            }
            return Promise.resolve();
        })
        .catch(utils.reject("Couldn't process remote message", true));
    };

    return {'Remote': Remote};
}); 
