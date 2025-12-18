const pool = require('../config/database');

const cache = {
  dropIds: {}
};

async function getDropIdByName(name) {
  if (cache.dropIds[name]) return cache.dropIds[name];
  const result = await pool.query(
    'SELECT drop_id FROM drops WHERE drop_name = $1 LIMIT 1',
    [name]
  );
  const id = result.rows[0]?.drop_id || null;
  cache.dropIds[name] = id;
  return id;
}

async function getDefaultDropId() {
  return getDropIdByName('Unassigned');
}

module.exports = {
  getDropIdByName,
  getDefaultDropId
};
