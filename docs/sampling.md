# Sampling parameters

Three knobs that were read but never settable.

`llm.js` has always sent `cfg.temperature` when it is present — but nothing ever set the field, because
`resolveConfig` never produced it. So every request ran at the provider's default and the only way to change that
was to edit the request builder.

## What is there now

| key | range | notes |
|---|---|---|
| `sampling` | on/off | The group switch. Off sends none of them. |
| `temperature` | 0–2 | Empty = provider default. |
| `top_p` | 0–1 | Nucleus sampling. Usually set INSTEAD of temperature. |
| `presence_penalty` | -2–2 | OpenAI-compatible only; Anthropic has no equivalent. |

## Three ways in

```
/sampling                          show the table
/sampling temperature 0.3          set one
/sampling off                      stop sending any of them
```

```
/set temperature 0.3               the generic path
/settings  → Model → Sampling      the browser
```

`config.toml`:

```toml
temperature = 0.3
top_p = 0.9
sampling = true
```

Environment overrides: `HNCODE_TEMPERATURE`, `HNCODE_TOP_P`, `HNCODE_PRESENCE_PENALTY`, `HNCODE_SAMPLING`.

## Decisions worth knowing

**Empty is not zero.** Clearing the field removes the parameter so the provider applies its own default. `0` is a
real temperature (deterministic), and silently turning "cleared" into `0` would change behaviour in a way the
user did not ask for.

**`sampling = false` sends nothing**, rather than sending defaults. Several providers reject `temperature` for
reasoning models; refusing the whole parameter is the only correct answer there.

**`presence_penalty` is deleted from the Anthropic body.** Anthropic errors on unknown fields rather than ignoring
them, so sharing one object across both builders would break every Anthropic request the moment someone set it.

**Out-of-range is clamped, not rejected.** `temperature = 5` becomes `2`; a non-number becomes "not set". A typo
in config should not stop the program from starting.

**Numbers, not strings.** The generic config writer stores what the user typed, and `llm.js` sends it straight
into the request — so `applySetting` converts this group to numbers on the way in. A provider handed `"0.3"`
rejects it or ignores it.
