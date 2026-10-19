#!/usr/bin/env python3
"""Local dev server: `python3 -m http.server`, plus the app's own routes.

The app writes /home, /character#<id> and /campaign#<code> into the address
bar (src/js/router.js). Those are not files, so a plain static server 404s a
reload of them; this one answers them with index.html, as `_redirects` does on
Cloudflare Pages.

    python3 tools/serve.py [port]      # default 8787, serves the project root
"""
import http.server
import os
import sys

ROUTES = {'/home', '/character', '/campaign'}
# Static pages served without their extension, as Cloudflare Pages does.
PAGES = {'/about': '/about.html'}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path.rstrip('/') in ROUTES:
            if path.endswith('/'):  # relative asset paths would resolve under it
                self.send_response(301)
                self.send_header('Location', path.rstrip('/') + ('?' + query if query else ''))
                self.end_headers()
                return
            self.path = '/index.html'
        elif path in PAGES:
            self.path = PAGES[path]
        super().do_GET()

    def do_HEAD(self):
        path = self.path.partition('?')[0]
        if path in ROUTES:
            self.path = '/index.html'
        elif path in PAGES:
            self.path = PAGES[path]
        super().do_HEAD()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f'Serving {ROOT} at http://localhost:{port}/home')
    http.server.ThreadingHTTPServer(('', port), Handler).serve_forever()
