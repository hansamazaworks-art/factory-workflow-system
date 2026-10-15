// Starts the app on the LAN. The app itself is built in ./app.js.
const app = require('./app');

// Last line of defence: log anything that slips past the route error
// handler instead of letting Node exit and drop every user's session.
process.on('unhandledRejection', err => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Factory system running.`);
  console.log(`- On this PC:   http://localhost:${PORT}`);
  console.log(`- On the LAN:   http://<this-PC's-IP-address>:${PORT}`);
});
