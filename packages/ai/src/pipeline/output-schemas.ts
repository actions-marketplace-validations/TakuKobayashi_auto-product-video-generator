import type { JsonSchema } from '../llm/provider.js';

const setupStep = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'command', 'background'],
  properties: {
    name: { type: 'string', minLength: 1 },
    command: { type: 'string', minLength: 1 },
    cwd: { type: 'string', minLength: 1 },
    background: { type: 'boolean' },
    readyUrl: { type: 'string', format: 'uri' },
    readyTimeoutMs: { type: 'integer', minimum: 1 },
  },
};

export const PROJECT_SUMMARY_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'description',
    'platform',
    'setupSteps',
    'features',
    'targetAudience',
    'keyValueProps',
    'suggestedVideoTypes',
  ],
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    platform: {
      type: 'string',
      enum: [
        'web',
        'cli',
        'ios',
        'android',
        'unity',
        'flutter',
        'react-native',
        'desktop',
        'other',
      ],
    },
    setupSteps: { type: 'array', items: setupStep },
    features: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'demoable', 'priority'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          route: { type: 'string', minLength: 1 },
          command: { type: 'string', minLength: 1 },
          demoable: { type: 'boolean' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    targetAudience: { type: 'string', minLength: 1 },
    keyValueProps: { type: 'array', items: { type: 'string', minLength: 1 } },
    suggestedVideoTypes: {
      type: 'array',
      items: { type: 'string', enum: ['teaser', 'shorts', 'demo', 'tutorial'] },
    },
  },
};

const action = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'url'],
      properties: { type: { const: 'goto' }, url: { type: 'string', format: 'uri' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'ms'],
      properties: { type: { const: 'wait' }, ms: { type: 'integer', minimum: 1 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'direction', 'amount'],
      properties: {
        type: { const: 'scroll' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'name'],
      properties: { type: { const: 'screenshot' }, name: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'command'],
      properties: { type: { const: 'run_command' }, command: { type: 'string', minLength: 1 } },
    },
  ],
};

export const SCENARIO_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['meta', 'scenes'],
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'description', 'type', 'duration', 'language'],
      properties: {
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        type: { type: 'string', enum: ['teaser', 'shorts', 'demo', 'tutorial'] },
        duration: { type: 'integer', minimum: 1 },
        language: { type: 'string', minLength: 1 },
      },
    },
    scenes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'narration', 'actions'],
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          narration: { type: 'string', minLength: 1 },
          emotion: {
            type: 'object',
            additionalProperties: false,
            required: ['j', 's', 'a'],
            properties: {
              j: { type: 'number', minimum: 0, maximum: 1 },
              s: { type: 'number', minimum: 0, maximum: 1 },
              a: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
          actions: { type: 'array', items: action },
        },
      },
    },
  },
};
