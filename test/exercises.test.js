import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Data validation for exercises.json (the Data layer). Keeps typos out as the
// library grows (#18). See the schema in CLAUDE.md.

const exercises = JSON.parse(
  readFileSync(new URL("../exercises.json", import.meta.url), "utf8")
);

const FOCUS = ["upper-abs", "lower-abs", "obliques", "deep-core", "full"];
const POSITION = ["back", "face-down", "other"];
const WARMUP = ["eligible", "only"];
const PATTERN = ["static", "dynamic", "rotational"];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test("library is a non-empty array", () => {
  assert.ok(Array.isArray(exercises));
  assert.ok(exercises.length > 0);
});

test("ids are unique kebab-case strings", () => {
  const seen = new Set();
  for (const e of exercises) {
    assert.match(e.id, KEBAB, `bad id: ${e.id}`);
    assert.ok(!seen.has(e.id), `duplicate id: ${e.id}`);
    seen.add(e.id);
  }
});

test("every exercise has valid fields", () => {
  for (const e of exercises) {
    const who = e.id;
    assert.ok(typeof e.name === "string" && e.name.length > 0, `${who}: name`);
    assert.ok(
      Array.isArray(e.focus) && e.focus.length > 0,
      `${who}: focus must be a non-empty array`
    );
    for (const f of e.focus) assert.ok(FOCUS.includes(f), `${who}: bad focus ${f}`);
    assert.ok(PATTERN.includes(e.pattern), `${who}: bad pattern ${e.pattern}`);
    assert.ok([1, 2, 3].includes(e.difficulty), `${who}: bad difficulty`);
    assert.equal(typeof e.perSide, "boolean", `${who}: perSide must be boolean`);
    assert.ok(
      typeof e.formCue === "string" && e.formCue.length > 0,
      `${who}: formCue`
    );
    if (e.workSeconds !== undefined) {
      assert.ok(
        Number.isInteger(e.workSeconds) && e.workSeconds > 0,
        `${who}: workSeconds must be a positive integer`
      );
    }
  }
});

test("every exercise has a valid position", () => {
  for (const e of exercises) {
    assert.ok(POSITION.includes(e.position), `${e.id}: bad position ${e.position}`);
  }
});

test("warmup is eligible, only, or omitted", () => {
  for (const e of exercises) {
    if (e.warmup !== undefined) {
      assert.ok(WARMUP.includes(e.warmup), `${e.id}: bad warmup ${e.warmup}`);
    }
  }
});

test("main pool (not warm-up only) has at least one move per position", () => {
  const pool = exercises.filter((e) => e.warmup !== "only");
  for (const p of POSITION) {
    assert.ok(
      pool.some((e) => e.position === p),
      `no main-pool exercise with position ${p}`
    );
  }
});

test("library includes at least one warm-up only move", () => {
  assert.ok(exercises.some((e) => e.warmup === "only"));
});
