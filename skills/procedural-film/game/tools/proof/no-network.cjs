// tools/proof/no-network.cjs : a --require preload that proves the gates need no network.
//
//   FILM_NO_NET=1 NODE_OPTIONS="--require $PWD/tools/proof/no-network.cjs" node tools/gates.cjs
//
// With FILM_NO_NET=1, net.connect / net.createConnection, tls.connect, http(s).request / get and
// dns.lookup throw for any host other than localhost, 127.0.0.1 or ::1 (a local socket path is allowed).
// NODE_OPTIONS carries the preload into every child node process the gates start. Browsers the gates
// launch are separate processes: they reach only the local server the gates start.
'use strict';

if (process.env.FILM_NO_NET === '1') {
  const net = require('net');
  const tls = require('tls');
  const http = require('http');
  const https = require('https');
  const dns = require('dns');
  const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
  const deny = (what, host) => {
    const e = new Error(`no-network.cjs: ${what} to '${host}' is blocked (FILM_NO_NET=1)`);
    e.code = 'EFILMNONET';
    throw e;
  };
  const check = (what, host) => {
    const h = String(host == null ? 'localhost' : host).toLowerCase();
    if (!LOCAL.has(h)) deny(what, h);
  };
  // the host of net/tls connect arguments: (options), (port, host), (path)
  const hostOfConnect = (args) => {
    const a = args[0];
    if (a && typeof a === 'object') return a.path ? 'localhost' : a.host || a.hostname || 'localhost';
    if (typeof a === 'string' && isNaN(Number(a))) return 'localhost'; // a socket path
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  };
  for (const [mod, name, fns] of [[net, 'net', ['connect', 'createConnection']], [tls, 'tls', ['connect']]]) {
    for (const fn of fns) {
      const orig = mod[fn];
      mod[fn] = function (...args) {
        check(`${name}.${fn}`, hostOfConnect(args));
        return orig.apply(this, args);
      };
    }
  }
  // the host of http(s).request arguments: (url | URL | options, [options], [cb])
  const hostOfRequest = (args) => {
    let host = null;
    for (const a of args) {
      if (typeof a === 'string') host = new URL(a).hostname;
      else if (a instanceof URL) host = a.hostname;
      else if (a && typeof a === 'object') host = a.hostname || a.host || host;
      if (host) break;
    }
    return host ? String(host).replace(/:\d+$/, '') : 'localhost';
  };
  for (const [mod, name] of [[http, 'http'], [https, 'https']]) {
    for (const fn of ['request', 'get']) {
      const orig = mod[fn];
      mod[fn] = function (...args) {
        check(`${name}.${fn}`, hostOfRequest(args));
        return orig.apply(this, args);
      };
    }
  }
  const lookup = dns.lookup;
  dns.lookup = function (host, ...rest) {
    check('dns.lookup', host);
    return lookup.call(this, host, ...rest);
  };
  if (dns.promises && dns.promises.lookup) {
    const pl = dns.promises.lookup;
    dns.promises.lookup = function (host, ...rest) {
      check('dns.promises.lookup', host);
      return pl.call(this, host, ...rest);
    };
  }
}
