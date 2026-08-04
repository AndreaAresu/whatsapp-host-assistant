// audio.js — l'adattatore audio→testo (Gemini), l'unico pezzo non-Claude.
// Gemini è finto: si verifica che i vocali fuori misura vengano fermati prima
// di costare qualcosa e che ogni fallimento degradi in modo prevedibile,
// perché a valle index.js ci conta per avvisare l'host.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// --- SDK Google finto ---
const chiamate = [];
let rispondi = async () => ({ text: 'trascrizione' });

class FakeGoogleGenAI {
  constructor() {
    this.models = {
      generateContent: async (params) => {
        chiamate.push(params);
        return rispondi(params);
      },
    };
  }
}

mock.module('@google/genai', { namedExports: { GoogleGenAI: FakeGoogleGenAI } });

const { transcribeAudio, isTranscriptionEnabled } = await import('../src/audio.js');
const { config } = await import('../src/config.js');

const vocale = (bytes = 1024) => Buffer.alloc(bytes, 1);
const mimeInviato = () => chiamate.at(-1).contents[0].parts[0].inlineData.mimeType;

beforeEach(() => {
  chiamate.length = 0;
  rispondi = async () => ({ text: 'trascrizione' });
  config.geminiApiKey = 'chiave-finta';
});

test('senza GEMINI_API_KEY la trascrizione è disattivata', async () => {
  config.geminiApiKey = undefined;

  assert.equal(isTranscriptionEnabled(), false);
  await assert.rejects(() => transcribeAudio(vocale(), 'audio/ogg'), /non configurata/);
  assert.equal(chiamate.length, 0, 'non deve nemmeno provarci');
});

test('con la chiave la trascrizione è attiva', () => {
  assert.equal(isTranscriptionEnabled(), true);
});

test('restituisce il testo trascritto, ripulito', async () => {
  rispondi = async () => ({ text: '  Ciao, a che ora posso arrivare?  ' });

  assert.equal(await transcribeAudio(vocale(), 'audio/ogg'), 'Ciao, a che ora posso arrivare?');
});

test('il MIME di WhatsApp viene ripulito dei parametri', async () => {
  // WhatsApp manda "audio/ogg; codecs=opus": Gemini vuole il MIME puro.
  await transcribeAudio(vocale(), 'audio/ogg; codecs=opus');

  assert.equal(mimeInviato(), 'audio/ogg');
});

test('senza mimetype si assume il formato dei vocali WhatsApp', async () => {
  await transcribeAudio(vocale(), undefined);

  assert.equal(mimeInviato(), 'audio/ogg');
});

test('un audio vuoto viene fermato prima della chiamata', async () => {
  await assert.rejects(() => transcribeAudio(Buffer.alloc(0), 'audio/ogg'), /Audio vuoto/);
  await assert.rejects(() => transcribeAudio(null, 'audio/ogg'), /Audio vuoto/);
  assert.equal(chiamate.length, 0);
});

test('un audio oltre i 20 MB viene rifiutato senza costare nulla', async () => {
  await assert.rejects(
    () => transcribeAudio(Buffer.alloc(21 * 1024 * 1024), 'audio/ogg'),
    /troppo lungo/
  );
  assert.equal(chiamate.length, 0, 'la chiamata costosa non deve partire');
});

test('un audio incomprensibile non diventa un messaggio finto', async () => {
  // null = "non ho capito": index.js avvisa l'host, che ascolta a mano.
  rispondi = async () => ({ text: '[INCOMPRENSIBILE]' });

  assert.equal(await transcribeAudio(vocale(), 'audio/ogg'), null);
});

test('una risposta vuota vale come "non ho capito"', async () => {
  rispondi = async () => ({ text: '   ' });
  assert.equal(await transcribeAudio(vocale(), 'audio/ogg'), null);

  rispondi = async () => ({});
  assert.equal(await transcribeAudio(vocale(), 'audio/ogg'), null);
});

test('una trascrizione lunghissima viene tagliata prima di entrare nel prompt', async () => {
  rispondi = async () => ({ text: 'a'.repeat(9000) });

  const testo = await transcribeAudio(vocale(), 'audio/ogg');

  assert.equal(testo.length, 4000);
});

test('se Gemini rifiuta il formato, l’errore arriva a chi deve avvisare l’host', async (t) => {
  // Il ripiego è la transcodifica con ffmpeg; qui il buffer non è audio vero,
  // quindi in ogni caso (ffmpeg presente o no) deve uscire l'errore originale.
  t.mock.method(console, 'log', () => {});
  rispondi = async () => { throw new Error('Unsupported MIME type'); };

  await assert.rejects(() => transcribeAudio(vocale(), 'audio/ogg'), /Unsupported MIME type/);
});

test('il prompt chiede una trascrizione letterale, senza commenti', async () => {
  await transcribeAudio(vocale(), 'audio/ogg');

  const testoPrompt = chiamate[0].contents[0].parts[1].text;
  assert.match(testoPrompt, /Trascrivi letteralmente/);
  assert.match(testoPrompt, /\[INCOMPRENSIBILE\]/);
});
