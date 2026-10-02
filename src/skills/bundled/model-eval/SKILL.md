---
openclaw:
  emoji: "🧪"
egirl:
  command:
    name: eval
    description: Evaluate a model, adapter, quantization or prompt change against its baseline
    args: what to evaluate (model, adapter, quant, prompt change or benchmark claim)
---

# Model Eval

Use when evaluating a model, adapter, quantization or prompt change, or judging a benchmark claim: held-out data, controls, repeated samples, read failures, compare to baseline.

## When to Use

Activate when asked whether a model change helps, whether a quant is good enough, which model
is better, or whether a reported benchmark number holds.

## Instructions

1. **Write the answer key first.** For each case, the expected answer and what counts as a pass,
   before you look at any output. Save it to a file.
2. **Held-out data only.** Find out what the change was trained or tuned on, and test on cases not
   in that set. Scoring on the training or tuning data is not evidence of improvement; say so if
   that is all there is.
3. **Controls alongside traps.** For every case where the right answer is to refuse, doubt or flag,
   add a matching case where the right answer is to just do it. A change that makes the model
   always cautious wins on traps and loses on controls; report both scores.
4. **Same harness, same settings.** Run baseline and candidate with the same prompts, system
   prompt, template, temperature, max tokens and grader. Record them.
5. **Several samples per condition.** At least 3 to 5 samples per case at the target temperature,
   or greedy plus samples. One run per condition is noise, not signal. Report the spread.
6. **Read every failure, and some passes.** A regex grader misses markdown (`**not**`, `*no*`),
   rewordings and lists, and accepts wrong answers that happen to contain the matching word.
   Strip markdown before matching, then read each failure and a sample of passes by hand, and
   correct the grade. Fluent, confident output is not correct output: check it against the key.
7. **No best-of.** Report every run you did, or the mean and spread, never the best one.
8. **Benchmark claims:** find the n, the split, the settings and the baseline. A claim missing
   any of them is unverified; rerun it on held-out data before you repeat it.

## Output Format

- **Verdict:** better / worse / no measurable difference, in one line.
- **Numbers:** baseline vs candidate per category (traps, controls), as passes/n, with samples
  per case and the spread.
- **Settings:** model files, template, temperature, grader, data split.
- **Failures read:** how many grades you corrected by hand, with one or two examples.
- **Limits:** what this eval can't tell you (small n, narrow domain, one prompt format).
