const fs = require('node:fs');
const path = require('node:path');
const { renderListing } = require('./listing');
function build() {
  const output = path.join(__dirname, 'public');
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  for (const name of ['living','kitchen','bedroom','kitchen-front','kitchen-side']) {
    if (!fs.existsSync(path.join(output,'assets',name+'.png'))) throw new Error('Missing generated demo photo: '+name);
  }
  for (const variant of ['legitimate','malicious']) fs.writeFileSync(path.join(output,variant+'.html'),renderListing(variant));
  fs.writeFileSync(path.join(output,'index.html'),renderListing('legitimate'));
  console.log('Built matching StayNest pages using the five existing original photos.');
}
if (require.main === module) build();
module.exports = { build };
