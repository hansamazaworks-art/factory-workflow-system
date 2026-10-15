// Logged-in HTTP clients for tests. Each agent keeps its own session cookie
// and, once the app issues one, the session's CSRF token, which `post`
// adds to every form submission the way a real browser form would.
const request = require('supertest');
const { PASSWORD } = require('./setup');

function tokenFrom(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html || '');
  return m ? m[1] : null;
}

async function anonymous(app) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  agent.csrf = tokenFrom(page.text);
  const rawPost = agent.post.bind(agent);
  agent.rawPost = rawPost; // no token added: used to prove CSRF rejection
  agent.post = async (url, data = {}) => {
    const body = agent.csrf ? { _csrf: agent.csrf, ...data } : data;
    return rawPost(url).type('form').send(body);
  };
  return agent;
}

async function login(app, username, password = PASSWORD) {
  const agent = await anonymous(app);
  const res = await agent.post('/login', { username, password });
  if (res.status !== 302) throw new Error(`login ${username} failed: ${res.status}`);
  agent.home = res.headers.location;
  // Pick up the token for the (possibly regenerated) logged-in session.
  const page = await agent.get('/account/change-password');
  agent.csrf = tokenFrom(page.text) || agent.csrf;
  return agent;
}

module.exports = { anonymous, login, tokenFrom };
