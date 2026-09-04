#!/usr/bin/env python3
"""E2E echo container: prints its argv (rendered template parameters) to
stdout, then serves HTTP 200 so the pod becomes Ready and EndpointReady can
be satisfied without a GPU or a real inference engine."""
import http.server
import sys

def main() -> None:
    print("ECHO_ARGV:" + " ".join(sys.argv[1:]), flush=True)
    handler = http.server.BaseHTTPRequestHandler

    def do_GET(self):  # noqa: N802
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    handler.do_GET = do_GET
    http.server.HTTPServer(("0.0.0.0", 8080), handler).serve_forever()

if __name__ == "__main__":
    main()
