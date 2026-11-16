import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('vernier_lab/static/vendor', { recursive: true });
copyFileSync('node_modules/plotly.js-basic-dist-min/plotly-basic.min.js', 'vernier_lab/static/vendor/plotly.min.js');
copyFileSync('node_modules/plotly.js-basic-dist-min/LICENSE', 'vernier_lab/static/vendor/plotly-LICENSE');
