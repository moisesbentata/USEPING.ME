const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export async function transcribeAudio(audio: Buffer, contentType: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: contentType }), "voice-note.ogg");
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "text");

  const res = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Groq transcription failed: ${res.status} ${await res.text()}`);
  }

  return (await res.text()).trim();
}
