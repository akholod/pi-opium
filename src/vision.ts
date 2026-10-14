// Routing for the vision agent: it exists for models that cannot see images.
// A model that can see them reads image files itself (Pi's `read` returns
// image content to such a model), so vision is hidden from it; a model that
// cannot gets image attachments saved to disk and a pointer to vision.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const VISION_AGENT = 'vision';
export const VISION_TOOL = 'vision';

// Children that may call vision themselves (one level deep). fixer,
// fast-generic, vision itself and the council seats never do.
export const VISION_DISPATCH_ROLES: readonly string[] = [
  'scout',
  'researcher',
  'senior',
  'designer',
];

export const VISION_DISPATCH_LINE =
  'When you need to see an image or visual file and cannot view it ' +
  'yourself, call the vision tool with its path and a precise goal, then ' +
  'work from its observations.';

export const VISION_REFUSAL =
  'your model can read images itself; use the read tool on the file ' +
  'instead of the vision agent';

interface ModelLike {
  input?: readonly string[];
}

// true / false from the model's declared input capability; undefined when
// the model, or its capability list, is unknown.
export const supportsImages = (
  model: ModelLike | undefined,
): boolean | undefined =>
  Array.isArray(model?.input) ? model.input.includes('image') : undefined;

// Capability of the model a `provider/id` string (or 'inherit' for the
// session model) names. Undefined when it cannot be resolved. Callers route
// on `=== true`, so unknown counts as "cannot see": a wrongly added vision
// route costs one cheap run, a missing one leaves the model blind.
export const modelSupportsImages = (
  ctx: Pick<ExtensionContext, 'model' | 'modelRegistry'>,
  modelRef: string | undefined,
): boolean | undefined => {
  if (modelRef === undefined || modelRef === '' || modelRef === 'inherit') {
    return supportsImages(ctx.model);
  }
  const slash = modelRef.indexOf('/');
  let model: ModelLike | undefined;
  if (slash > 0) {
    try {
      model = ctx.modelRegistry.find(
        modelRef.slice(0, slash),
        modelRef.slice(slash + 1),
      );
    } catch {
      // an unreadable registry is an unknown model
    }
  }
  return supportsImages(model);
};

// Agent names the orchestrator may call: vision only for a model that
// cannot see images (see modelSupportsImages for how unknown is treated).
export const orchestratorAgents = (
  names: readonly string[],
  model: ModelLike | undefined,
): string[] =>
  supportsImages(model) === true
    ? names.filter((name) => name !== VISION_AGENT)
    : [...names];

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface AttachedImage {
  data: string;
  mimeType: string;
}

// Content-addressed: the same image is written once per session.
export const saveImages = (
  cwd: string,
  sessionId: string,
  images: readonly AttachedImage[],
): string[] => {
  const dir = join(cwd, '.pi', 'opium', 'images', sessionId);
  mkdirSync(dir, { recursive: true });
  return images.map((image) => {
    const bytes = Buffer.from(image.data, 'base64');
    const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const path = join(dir, `${sha}.${EXTENSIONS[image.mimeType] ?? 'png'}`);
    writeFileSync(path, bytes);
    return path;
  });
};

export const attachedImageNote = (path: string): string =>
  `Attached image saved at ${path}. Your model cannot view images: ` +
  'delegate to the vision agent with this path and a precise goal.';

export type ImageInputResult = {
  action: 'transform';
  text: string;
  images: [];
};

// For a model that cannot see images: saves the attached images and swaps
// them for text pointing at the files. Undefined (input untouched) for a model
// that can see them, without images, or when the files cannot be written (Pi
// then sends its own "image omitted" placeholder).
export const imageInput = (
  event: { text: string; images?: readonly AttachedImage[] },
  ctx: Pick<ExtensionContext, 'cwd' | 'model' | 'modelRegistry'> & {
    sessionManager: Pick<ExtensionContext['sessionManager'], 'getSessionId'>;
  },
): ImageInputResult | undefined => {
  const { images } = event;
  let result: ImageInputResult | undefined;
  if (images?.length && ctx.model && supportsImages(ctx.model) !== true) {
    try {
      const paths = saveImages(
        ctx.cwd,
        ctx.sessionManager.getSessionId(),
        images,
      );
      const notes = [...new Set(paths)].map(attachedImageNote);
      result = {
        action: 'transform',
        text: [event.text, ...notes].join('\n\n'),
        images: [],
      };
    } catch {
      // unwritable: the input goes through as it was
    }
  }
  return result;
};
