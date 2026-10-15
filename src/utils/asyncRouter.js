// An Express Router whose handlers may be async.
//
// Express 4 does not catch a rejected promise from an async handler: the
// request hangs, and Node (15+) then exits on the unhandled rejection,
// taking the whole server down for every user. This router wraps every
// handler so a thrown error or rejected promise goes to next(err), where
// the central error handler in src/app.js shows an error page instead.
//
// Usage (drop-in for express.Router()):
//   const router = require('../utils/asyncRouter')();
const express = require('express');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

function wrap(fn) {
  // Error handlers (err, req, res, next) and non-functions pass through.
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  return function wrapped(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function wrapArgs(args) {
  return args.map(a => (Array.isArray(a) ? wrapArgs(a) : wrap(a)));
}

module.exports = function asyncRouter(options) {
  const router = express.Router(options);
  for (const m of METHODS) {
    const original = router[m].bind(router);
    router[m] = (...args) => original(...wrapArgs(args));
  }
  return router;
};
