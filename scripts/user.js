// Manage login accounts from the host PC.
//
//   npm run user -- list
//   npm run user -- add <username> "<Full Name>" <role> ["Department"]
//   npm run user -- role <username> <role> ["reason"]
//   npm run user -- deactivate <username> ["reason"]
//   npm run user -- activate <username> ["reason"]
//   npm run user -- reset-password <username> ["reason"]
//
// New accounts and reset passwords get the starter password password123;
// the person must choose their own the first time they log in.
// Roles: production, maintenance (technician), maintenance_manager,
//        plant_manager, toolroom, purchasing, management, admin
// A role change or deactivation takes effect on that person's next click.
const pool = require('../src/config/db');
const users = require('../src/services/users');
const { ROLE_LABELS } = require('../src/constants/permissions');

const [command, ...rest] = process.argv.slice(2);

const HELP = `Usage:
  npm run user -- list
  npm run user -- add <username> "<Full Name>" <role> ["Department"]
  npm run user -- role <username> <role> ["reason"]
  npm run user -- deactivate <username> ["reason"]
  npm run user -- activate <username> ["reason"]
  npm run user -- reset-password <username> ["reason"]
Roles: ${users.ROLES.join(', ')}`;

(async () => {
  try {
    switch (command) {
      case 'list': {
        const rows = await users.list(pool);
        for (const u of rows) {
          console.log(`${u.is_active ? '      ' : '[off] '}${u.username.padEnd(16)} ${(ROLE_LABELS[u.role] || u.role).padEnd(24)} ${u.full_name}${u.department ? ' · ' + u.department : ''}`);
        }
        break;
      }
      case 'add': {
        const [username, fullName, role, department] = rest;
        await users.add(pool, { username, fullName, role, department });
        console.log(`Created ${username} (${ROLE_LABELS[role]}). Starter password: password123 - they must change it at first login.`);
        break;
      }
      case 'role': {
        const [username, role, reason] = rest;
        const changed = await users.setRole(pool, username, role, reason);
        console.log(changed ? `${username} is now ${ROLE_LABELS[role]}. This applies on their next click.` : `${username} already has that role.`);
        break;
      }
      case 'deactivate':
      case 'activate': {
        const [username, reason] = rest;
        const changed = await users.setActive(pool, username, command === 'activate', reason);
        console.log(changed ? `${username} ${command}d.` : `${username} was already ${command}d.`);
        break;
      }
      case 'reset-password': {
        const [username, reason] = rest;
        await users.resetPassword(pool, username, reason);
        console.log(`${username}'s password is now password123. They must change it at next login.`);
        break;
      }
      default:
        console.log(HELP);
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof users.UserError) {
      console.error(err.message);
    } else {
      console.error('Failed:', err.message);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
