import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('physllama/static/vendor', { recursive: true });
copyFileSync('node_modules/plotly.js-basic-dist-min/plotly-basic.min.js', 'physllama/static/vendor/plotly.min.js');
copyFileSync('node_modules/plotly.js-basic-dist-min/LICENSE', 'physllama/static/vendor/plotly-LICENSE');
