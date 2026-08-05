# Deepgram tuning harness

Replay a real recorded session against a matrix of Deepgram settings, and get
numbers instead of guesses. Built for #12, prompted by #10 and by the
`utteranceEndMs 1500 → 3000` change in `460980e` — which was reasoned from
code rather than measured.

## Why not just stream the mp3 at Deepgram?

Two traps, and both produce confident wrong answers.

**The mix is the wrong input.** `utterance_end_ms` and `endpointing` act on
**per-speaker** silence structure. In a mixed recording somebody is almost
always talking, so the silence pattern bears no relation to any individual
stream. You would be tuning against audio that no Deepgram socket ever sees.

**A naive replay tunes the wrong knob.** The dominant segment-length control in
production is *our* forced `Finalize`, not Deepgram's endpointing. Discord only
sends frames while someone is speaking, so when a speaker stops there is no
trailing silence on the socket for Deepgram to endpoint on — the `setTimeout`
in `RecordingSession.onSpeakerEnd` is what closes the segment. Streaming a file
straight through exercises only endpointing, i.e. the knob that matters least.

So the harness replays **speaking boundaries as well as audio**, and drives the
**real `RecordingSession`** — same class, same `createDeepgramStream`, same
forced-finalize timer and turn-taking logic that production runs. The only
concession is the `tuning` override the session accepts, which nothing but this
harness sets.

The boundaries need no extra metadata: `padSilenceAndAppend` inserts real
silence to keep each speaker's byte offset on the shared wall clock, so the
non-silent regions of a per-speaker file **are** the speaking intervals. That
recovery lives in `src/recording/pcm-speech-regions.ts`.

## 1. Build a corpus

Per-speaker PCM is deleted at stop. Retain it for one session:

```bash
DISRECORD_KEEP_PCM=1 npm start
```

Files land in `$OUTPUT_DIR/pcm/<recordingId>/`, one or more numbered chunks per
speaker (`<userId>-000.pcm`).

> ⚠️ **This is the most sensitive artifact the container holds** — each
> consenting speaker's raw, un-mixed voice, with no mix to hide behind. It is
> opt-in for that reason, every session that retains it logs a `WARN`, and it
> should never be on by default. Record **one consented session**, turn the flag
> back off, and delete the corpus when the tuning work is done.

## 2. Build a reference transcript

The manual step, done once. Take that session's VTT, correct it by hand, and it
becomes reusable ground truth for every future sweep. Plain text works too — the
harness strips VTT scaffolding when it sees `WEBVTT`, and otherwise takes the
file as-is.

Without a reference the harness still reports everything except WER.

> ⚠️ **Correct a sample, not a whole session.** WER is O(reference × hypothesis)
> comparisons, which is instant on the few-thousand-word transcripts a
> `--limit-sec` sample produces and would appear to hang on a full multi-hour
> reference. Keep the reference the same length as the sample you replay.

## 3. Run the sweep

```bash
DISRECORD_TUNING=1 npm run tune:deepgram -- \
  --pcm-dir /data/recordings/pcm/<recordingId> \
  --reference ./corrected.vtt
```

| flag | meaning |
|---|---|
| `--pcm-dir` | corpus directory (required) |
| `--reference` | hand-corrected transcript; omit to skip WER |
| `--limit-sec` | truncate the sample — see the note on speed below |
| `--matrix` | JSON array of `{utteranceEndMs, endpointing}`; defaults to a 4-point sweep |
| `--model` / `--language` | default to `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` |

Audio is fed at **approximately real time**, deliberately. Endpointing is
silence-sensitive, so blasting the file through compresses the gaps and changes
the behaviour under test. That bounds the matrix: a 10-minute sample costs about
10 minutes *per combination*. To spend less, shorten the **sample** with
`--limit-sec` rather than speeding up playback — that keeps every gap the right
length.

## What it reports

```
uttEnd/endpt  WER    segments  p50 latency  words/seg
------------  -----  --------  -----------  ---------
1500/1000     14.2%  312       1180ms       6.0
3000/2000     11.8%  147       2360ms       13.0
```

| metric | answers |
|---|---|
| WER against the reference | #10 — is accuracy actually better? |
| final-segment count | #11 — how many thread messages would this have produced? |
| p50 speech-end → final | what latency are we paying? |
| words per segment | proxy for how much context the model had |

## Guardrails

- **Refuses to run without `DISRECORD_TUNING=1`.** It streams real audio to
  Deepgram and bills real usage, so it can never fire in CI or unattended.
- **Use a separate dev key.** Harness runs bill real usage and mixing them
  pollutes production usage figures.
- Lives in `tools/`, which is typechecked by `npm run typecheck` but is **not**
  part of the build — it never ships inside the production image.

## Related

- `tests/integration/deepgram-url-contract.test.ts` asserts the URL/parameter
  contract; this is its behavioural counterpart.
- Once a corpus exists, #10's "did the vendor change nova-3 under us?" becomes
  answerable by re-running the same corpus and diffing, rather than inferred
  from user reports.
