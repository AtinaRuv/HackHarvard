import { getPhoton, stopPhoton } from './client.js';
import 'dotenv/config'

export async function sendText(to, body) {
  if(typeof to!=='string'||typeof body!=='string'||!body)throw new Error('Provide a recipient and message body.');
  const {im}=await getPhoton();
  return await (await im.space.create(await im.user(to))).send(body);
}

