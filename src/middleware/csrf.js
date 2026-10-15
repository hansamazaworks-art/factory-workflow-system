// CSRF protection without extra dependencies.
//
// Every session gets one random token. Each rendered page has the token
// added as a hidden field to every <form method="POST">, so no template
// has to remember it. Any POST without the matching token is refused with
// 403, which stops another web page from submitting forms in a logged-in
// user's name.
const crypto = require('crypto');

const FIELD = '_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORM_TAG = /<form\b[^>]*\bmethod\s*=\s*["']?post["']?[^>]*>/gi;

function tokenFor(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function matches(expected, given) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

module.exports = function csrf(req, res, next) {
  const token = tokenFor(req);
  res.locals.csrfToken = token;

  // Inject the hidden field into every POST form on rendered pages.
  const render = res.render.bind(res);
  res.render = (view, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    render(view, options, (err, html) => {
      if (err) return callback ? callback(err) : req.next(err);
      const out = html.replace(FORM_TAG, tag => `${tag}<input type="hidden" name="${FIELD}" value="${res.locals.csrfToken}">`);
      return callback ? callback(null, out) : res.send(out);
    });
  };

  if (SAFE.has(req.method)) return next();
  if (req.body && matches(token, req.body[FIELD])) return next();

  res.status(403).render('error', {
    message: 'This form was out of date or came from another page. Go back, reload the page and try again.',
    user: req.session.user || null
  });
};
