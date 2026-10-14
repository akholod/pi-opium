// The `vision` tool of a child whose own model cannot see images: it runs
// the vision agent one level down, as a child of this child. The runner
// allows that only with `maxDepth: 2` (a child's tools run at depth 1).

import { runAgent } from 'pi-agent-runner';
import { Type } from 'typebox';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { AgentDefinition } from './agents.ts';
import { buildLaunch, discoverSkills, skillResolver } from './launch.ts';
import { VISION_AGENT, VISION_TOOL } from './vision.ts';

export const NESTED_MAX_DEPTH = 2;

export interface VisionToolDeps {
  // fresh definition (with the user's overrides) of the vision agent
  loadDef: (name: string) => AgentDefinition;
  run?: typeof runAgent;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? '');

export const visionTool =
  (child: string, deps: VisionToolDeps): ExtensionFactory =>
  (pi) => {
    pi.registerTool({
      name: VISION_TOOL,
      label: 'Vision',
      description:
        'Look at an image, screenshot, PDF or diagram you cannot view ' +
        'yourself: a vision agent reads the file and returns its ' +
        'observations (exact text included) for the goal you give.',
      promptSnippet: 'Have a vision agent describe an image or visual file',
      parameters: Type.Object({
        path: Type.String({ description: 'Path of the image or visual file' }),
        goal: Type.String({
          description: 'What to find out, as precisely as possible',
        }),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const def = deps.loadDef(VISION_AGENT);
        const resolveSkill = def.skills.length
          ? skillResolver(await discoverSkills(ctx.cwd))
          : undefined;
        const launch = buildLaunch(def, {
          parent: { events: pi.events, ctx },
          cwd: ctx.cwd,
          resolveSkill,
        });
        const result = await (deps.run ?? runAgent)({
          ...launch.start,
          ...launch.turn,
          task: `File: ${params.path}\n\nGoal: ${params.goal}`,
          maxDepth: NESTED_MAX_DEPTH,
          label: { name: VISION_AGENT, context: `for ${child}` },
          signal,
        });
        const answer = text(result.value);
        // pi treats a tool call as failed only when execute throws
        if (result.status !== 'completed') {
          throw new Error(
            `vision ${result.status}${result.error ? `: ${result.error}` : ''}${
              answer ? `\n${answer}` : ''
            }`,
          );
        }
        return {
          content: [{ type: 'text' as const, text: answer }],
          details: { status: result.status },
        };
      },
    });
  };
