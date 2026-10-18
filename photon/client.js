import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';

let connection;
export function getPhoton() {
  if (!process.env.SPECTRUM_PROJECT_ID || !process.env.SPECTRUM_PROJECT_SECRET) throw new Error('Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET.');
  connection ??= Spectrum({ projectId:process.env.SPECTRUM_PROJECT_ID, projectSecret:process.env.SPECTRUM_PROJECT_SECRET, providers:[imessage.config()] })
    .then(app=>({app,im:imessage(app)})).catch(error=>{connection=undefined;throw error});
  return connection;
}
export async function stopPhoton() { const current=connection;connection=undefined;if(current)await (await current).app.stop(); }
