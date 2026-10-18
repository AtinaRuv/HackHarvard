import { createClient, AudioCodec } from '@photon-ai/voice-ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);

export async function synthesize(text) {
  const directory = await mkdtemp(join(tmpdir(), 'leash-voice-'));
  try {
    const wav = join(directory, 'speech.wav');
    // A fixed text file avoids both shell interpolation and open stdin handles.
    await writeFile(join(directory, 'text.txt'), text);
    await exec(process.env.ESPEAK_BINARY || 'espeak', ['-s', '155', '-w', wav, '-f', join(directory, 'text.txt')], { timeout: 10000 });
    const raw = join(directory, 'speech.ulaw');
    await exec(process.env.FFMPEG_BINARY || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-ar', '8000', '-ac', '1', '-f', 'mulaw', raw], { timeout: 10000 });
    return await readFile(raw);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export class PhotonVoice {
  constructor({ token, from, onAnswer = async () => {}, synthesizeAudio = synthesize, client } = {}) {
    this.from = from; this.onAnswer = onAnswer; this.synthesizeAudio = synthesizeAudio;
    this.client = client || createClient({ token, retry: false, tls: true });
    this.pending = new Map(); this.stream = this.client.calls.subscribe();
    this.unsubscribe = this.stream.on(event => {
      if (event.type === 'call.answered') void this.speak(event.callControlId).catch(error => console.error('Photon call audio:', error.message));
      if (event.type === 'call.hangup') void this.finish(event.callControlId).catch(error => console.error('Photon call answer:', error.message));
    });
  }
  async call(to, text, context) {
    if (!/^\+[1-9]\d{6,14}$/.test(to)) throw new Error('Organizer phone must be in international format.');
    const audio = await this.synthesizeAudio(text + (context.field && !process.env.VOICE_TRANSCRIBE_URL ? ' Please reply by text with your answer.' : ''));
    const call = await this.client.calls.dial(to, { from: this.from });
    const entry = { audio, context, inbound: [], bytes: 0 };
    entry.timer = setTimeout(() => { void this.client.calls.hangup(call.callControlId).catch(() => {}); void this.finish(call.callControlId).catch(error=>console.error('Photon call finish:',error.message)); }, 90000);
    entry.timer.unref?.(); this.pending.set(call.callControlId, entry);
    return { id: call.callControlId };
  }
  async speak(id) {
    const entry = this.pending.get(id);
    if (!entry || entry.media) return;
    const media = this.client.media.openStream({ callControlId: id, codec: AudioCodec.pcmu8000, sendInbound: Boolean(entry.context.field) });
    entry.media = media;
    media.events.on(event => {
      if (event.type === 'frame' && entry.bytes < 8000 * 60) { entry.inbound.push(Buffer.from(event.audio)); entry.bytes += event.audio.length; }
    });
    media.sendFrame(entry.audio); media.mark('question_finished');
    if (!entry.context.field) {
      const timer = setTimeout(() => void this.client.calls.hangup(id).catch(() => {}), Math.ceil(entry.audio.length / 8) + 1000);
      timer.unref?.();
    }
  }
  async finish(id) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id); clearTimeout(entry.timer); await entry.media?.stop();
    if (entry.context.field && entry.bytes && process.env.VOICE_TRANSCRIBE_URL) {
      const response = await fetch(process.env.VOICE_TRANSCRIBE_URL, { method: 'POST', headers: { 'Content-Type': 'audio/basic', ...(process.env.VOICE_TRANSCRIBE_TOKEN ? { Authorization: `Bearer ${process.env.VOICE_TRANSCRIBE_TOKEN}` } : {}) },
        body: Buffer.concat(entry.inbound), signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error('Speech transcription failed. Answer by text instead.');
      const result = await response.json();
      if (typeof result.text !== 'string' || result.text.length > 500) throw new Error('Invalid speech transcript.');
      await this.onAnswer(entry.context, result.text.trim());
    }
  }
  async close() { this.unsubscribe?.(); await this.stream.close(); for (const id of this.pending.keys()) await this.finish(id); await this.client.close(); }
}
