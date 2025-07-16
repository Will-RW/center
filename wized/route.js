// wized/route.js
const fs   = require('fs');
const path = require('path');

module.exports = function wizedHandler (req, res) {
  try {
    /* 1) raw JS file containing %%ID%% and %%TOKEN%% */
    let js = fs.readFileSync(path.join(__dirname, 'wized.js'), 'utf8');

    /* 2) pick the correct domain entry */
    const map = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'domain.json'), 'utf8')
    );
    const site   = (req.query.site || '').toLowerCase();
    const id     = (map[site] || map.default || {}).id || 'none';

    /* 3) inject token from env */
    const token  = process.env.CENTROID_TOKEN || 'UNSET';

    /* 4) replace placeholders & send */
    js = js.replace('%%ID%%', id).replace('%%TOKEN%%', token);
    res.type('application/javascript').send(js);
  } catch (err) {
    console.error('[wized.js] error →', err.message);
    res.status(500).send('// server error');
  }
};
