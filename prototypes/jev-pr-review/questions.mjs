// Question library for the Jev PR review prototype.
//
// Tier 0  — asked of every hunk, every run. Fixed wording so thresholds can be calibrated.
// Tier 0s — speculative Tier 1 questions sent in the SAME request as Tier 0 (same state,
//           premise stated explicitly). policy.mjs decides whether each answer is consumed.
// Tier 1  — follow-ups that need DIFFERENT state (test hunks, full file, description
//           bullets), so they cost a second request. Built by the functions at the bottom.
//
// State paths referenced in backticks match the objects built in review.mjs.

export const TIER0 = {
  change_kind: {
    type: 'choice',
    instructions:
      'What kind of change is the diff in `hunk.diff` (file `hunk.file`)? Judge by what the added and removed lines do, not by the file name alone.',
    criteria: {
      behaviour: 'Changes what runtime code does: logic, control flow, data handling, commands a script runs.',
      agent_instructions:
        'Changes text an AI agent follows: a skill, prompt, agent definition or instruction file, in a way that could change what the agent does.',
      contract:
        'Changes an interface others rely on: a tool or input schema, exported function signature, CLI flag, config key, file format or output shape.',
      test: 'Adds or changes tests, evals, fixtures or test helpers only.',
      docs: 'Changes documentation meant for human readers, with no effect on agent or code behaviour.',
      config_ci: 'Changes CI workflows, build config, manifests or dependency declarations.',
      refactor: 'Restructures code or text with the intent of keeping behaviour the same.',
      trivial: 'Whitespace, formatting, typo or comment-only change.',
    },
  },

  matches_description: {
    type: 'noul',
    instructions:
      'The change in `hunk.diff` serves a goal stated in the pull request title `pr.title` or description `pr.body`.',
    criteria: {
      true: 'The hunk clearly works towards something the title or description says the PR does.',
      false: 'Nothing in the title or description accounts for this hunk.',
    },
  },

  touches_contract: {
    type: 'noul',
    instructions:
      'The change in `hunk.diff` alters something that other code, other skills, or users depend on: a schema, a function signature, a CLI flag or argument, a file or output format, a config key, or an instruction another skill refers to.',
  },

  risk: {
    type: 'score',
    instructions:
      'If the change in `hunk.diff` were wrong, how much damage could it do once merged?',
    criteria: [
      'None: a wrong version would be cosmetic, e.g. a typo, wording or a comment.',
      'Low: a wrong version would cause a visible but contained problem that a user would notice and route around.',
      'Medium: a wrong version would silently produce wrong output or make an automated loop take the wrong step.',
      'High: a wrong version could delete or overwrite data, leak credentials, push, merge or publish something, or break every run.',
    ],
  },
};

export const TIER0_SPECULATIVE = {
  // Consumed when change_kind is contract, or touches_contract is high.
  backcompat_if_contract: {
    type: 'noul',
    instructions:
      'Assume `hunk.diff` changes an interface others depend on. Existing callers, users or skills that follow the old interface would keep working without any change on their side.',
  },

  // Consumed when change_kind is refactor.
  behaviour_shift_if_refactor: {
    type: 'noul',
    instructions:
      'Assume `hunk.diff` is intended as a pure refactor. At least one removed line and its replacement would do something observably different: a different command, condition, default, output or order of steps.',
  },

  // Consumed when change_kind is agent_instructions.
  instruction_new_action_if_agent: {
    type: 'noul',
    instructions:
      'Assume `hunk.diff` edits instructions an AI agent follows. After this change, in some situation the agent handled before, it would now take a different action: run a different command, skip or add a step, or ask instead of act (or the reverse).',
  },
  instruction_ambiguous_if_agent: {
    type: 'noul',
    instructions:
      'Assume `hunk.diff` edits instructions an AI agent follows. An added line can reasonably be read in two ways that lead the agent to different actions.',
  },
};

// ---- Tier 1 builders: each returns { state, questions } for one extra request. ----

// Contract change → do the PR's test hunks exercise it?
export function testsCoverContract(base, testHunks) {
  return {
    state: { ...base, test_hunks: testHunks.map((h) => ({ file: h.file, diff: h.diff })) },
    questions: {
      tests_cover_change: {
        type: 'noul',
        instructions:
          'At least one diff in `test_hunks` adds or changes a test that exercises the behaviour changed in `hunk.diff`.',
      },
    },
  };
}

// Uncertain judgment → re-ask with the whole file as added evidence. Uncertain usually
// means missing context, so fetch more before escalating.
export function reaskWithFile(base, fileText, questionIds) {
  const questions = {};
  for (const id of questionIds) {
    const q = TIER0[id];
    questions[id] = {
      ...q,
      instructions: `${q.instructions} The full file after the change is in \`file_after\`; use it to understand what the hunk connects to.`,
    };
  }
  return { state: { ...base, file_after: fileText }, questions };
}

// Hunk doesn't match the description → which stated goal (if any) does it serve?
export function whichGoal(base, bullets) {
  const criteria = Object.fromEntries(bullets.map((b, i) => [`goal_${i}`, b]));
  criteria.none = 'None of the listed goals: the hunk does something the description does not mention.';
  return {
    state: base,
    questions: {
      serves_goal: {
        type: 'choice',
        instructions:
          'Which goal from the pull request description does the change in `hunk.diff` serve?',
        criteria,
      },
    },
  };
}
