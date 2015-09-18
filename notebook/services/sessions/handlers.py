"""Tornado handlers for the sessions web service.

Preliminary documentation at https://github.com/ipython/ipython/wiki/IPEP-16%3A-Notebook-multi-directory-dashboard-and-URL-mapping#sessions-api
"""

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

import os
import json

from tornado import gen, web
from tornado.websocket import WebSocketHandler

from ...base.handlers import APIHandler, IPythonHandler, json_errors
from ...base.zmqhandlers import AuthenticatedZMQStreamHandler, deserialize_binary_message
from jupyter_client.jsonutil import date_default
from ipython_genutils.py3compat import cast_unicode
from notebook.utils import url_path_join, url_escape
from jupyter_client.kernelspec import NoSuchKernel


class SessionRootHandler(APIHandler):

    @web.authenticated
    @json_errors
    def get(self):
        # Return a list of running sessions
        sm = self.session_manager
        sessions = sm.list_sessions()
        self.finish(json.dumps(sessions, default=date_default))

    @web.authenticated
    @json_errors
    def post(self):
        # Creates a new session
        #(unless a session already exists for the named nb)
        sm = self.session_manager
        cm = self.contents_manager
        km = self.kernel_manager

        model = self.get_json_body()
        if model is None:
            raise web.HTTPError(400, "No JSON data provided")
        try:
            path = model['notebook']['path']
        except KeyError:
            raise web.HTTPError(400, "Missing field in JSON data: notebook.path")
        try:
            kernel_name = model['kernel']['name']
        except KeyError:
            self.log.debug("No kernel name specified, using default kernel")
            kernel_name = None

        # Check to see if session exists
        if sm.session_exists(path=path):
            model = sm.get_session(path=path)
        else:
            try:
                model = sm.create_session(path=path, kernel_name=kernel_name)
            except NoSuchKernel:
                msg = ("The '%s' kernel is not available. Please pick another "
                       "suitable kernel instead, or install that kernel." % kernel_name)
                status_msg = '%s not found' % kernel_name
                self.log.warn('Kernel not found: %s' % kernel_name)
                self.set_status(501)
                self.finish(json.dumps(dict(message=msg, short_message=status_msg)))
                return

        location = url_path_join(self.base_url, 'api', 'sessions', model['id'])
        self.set_header('Location', url_escape(location))
        self.set_status(201)
        self.finish(json.dumps(model, default=date_default))

    @web.authenticated
    @json_errors
    def options(self):
        self.set_header('Access-Control-Allow-Headers', 'accept, content-type')
        self.finish()

class SessionHandler(APIHandler):

    SUPPORTED_METHODS = ('GET', 'POST', 'PATCH', 'DELETE')

    @web.authenticated
    @json_errors
    def get(self, session_id):
        # Returns the JSON model for a single session
        sm = self.session_manager
        model = sm.get_session(session_id=session_id)
        self.finish(json.dumps(model, default=date_default))

    @web.authenticated
    @json_errors
    def post(self, session_id):
        sm = self.session_manager
        cm = self.contents_manager

        data = self.get_json_body()
        self.log.info("data %s" % data)
        if data is None:
            raise web.HTTPError(400, "No JSON data provided")
        try:
            exec_cells = data['cells']
        except KeyError:
            raise web.HTTPError(400, "Missing field in JSON data: cells")

        model = sm.get_session(session_id=session_id)
        self.log.info("model %s" % model)
        try:
            path = model['notebook']['path']
        except KeyError:
            raise web.HTTPError(400, "Missing field in JSON data: notebook.path")


        notebook = cm.get(path)
        cells = notebook['content']['cells']
        cellscount = len(cells)
        # Check if cells exists
        for x in exec_cells:
            if x >= cellscount:
                raise web.HTTPError(410, "Cell %d out of range" % x)

        try:
            controller = sm.get_channel(session_id)
            controller.write_message({"exec": exec_cells})

        except KeyError:
            raise web.HTTPError(410, "WebSocket is unavailable")

        self.log.info("receive request to execute cells %s" % exec_cells)
        self.finish(json.dumps(data, default=date_default))

    @web.authenticated
    @json_errors
    def patch(self, session_id):
        # Currently, this handler is strictly for renaming notebooks
        sm = self.session_manager
        model = self.get_json_body()
        if model is None:
            raise web.HTTPError(400, "No JSON data provided")
        changes = {}
        if 'notebook' in model:
            notebook = model['notebook']
            if 'path' in notebook:
                changes['path'] = notebook['path']

        sm.update_session(session_id, **changes)
        model = sm.get_session(session_id=session_id)
        self.finish(json.dumps(model, default=date_default))

    @web.authenticated
    @json_errors
    def delete(self, session_id):
        # Deletes the session with given session_id
        sm = self.session_manager
        try:
            sm.delete_session(session_id)
        except KeyError:
            # the kernel was deleted but the session wasn't!
            raise web.HTTPError(410, "Kernel deleted before session")
        self.set_status(204)
        self.finish()


class ControlChannelHandler(AuthenticatedZMQStreamHandler, IPythonHandler):

    def initialize(self):
        super(ControlChannelHandler, self).initialize()
        self.channels = {}

    @gen.coroutine
    def get(self, session_id):
        self.session_id = cast_unicode(session_id, 'ascii')
        yield super(ControlChannelHandler, self).get(session_id=session_id)
    
    def open(self, session_id):
      sm = self.session_manager
      if sm.get_channel(session_id):
          sm.close_channel(session_id)
          self.log.info("closing previous channel")
      sm.set_channel(session_id, self)
      self.log.info("%s WebSocket opened for session %s" % (self, session_id))

    def on_message(self, msg):
        if isinstance(msg, bytes):
            msg = deserialize_binary_message(msg)
        else:
            try:
                msg = json.loads(msg)
                self.log.info("Received message %s" % msg)
                self.write_message(msg)
            except ValueError as e:
                self.write_message({'error': e})
                self.log.error('error %s' % e)

    def on_close(self):
      self.log.info("WebSocket closed")


#-----------------------------------------------------------------------------
# URL to handler mappings
#-----------------------------------------------------------------------------

_session_id_regex = r"(?P<session_id>\w+-\w+-\w+-\w+-\w+)"

default_handlers = [
    (r"/api/sessions/%s" % _session_id_regex, SessionHandler),
    (r"/api/sessions/%s/ws" % _session_id_regex, ControlChannelHandler),
    (r"/api/sessions",  SessionRootHandler)
]

