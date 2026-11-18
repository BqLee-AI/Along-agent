import { z } from 'zod';

// Fixed published bytes, not a model-name alias or a permission to fetch assets.
export const PINNED_ENCODING_FILES = [
  {
    path: 'config.json',
    bytes: 716,
    sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  },
  {
    path: 'onnx/model_int8.onnx',
    bytes: 23903394,
    sha256: 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5',
  },
  {
    path: 'quantize_config.json',
    bytes: 674,
    sha256: '2cc488b20fa05fe86aba2fdc2be44d24827e11e2b7c7a0753d1427da6797b46f',
  },
  {
    path: 'special_tokens_map.json',
    bytes: 125,
    sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
  },
  {
    path: 'tokenizer.json',
    bytes: 439125,
    sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  },
  {
    path: 'tokenizer_config.json',
    bytes: 367,
    sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  },
  {
    path: 'vocab.txt',
    bytes: 109540,
    sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
  },
] as const;
const graphInput = z
  .object({
    name: z.enum(['input_ids', 'attention_mask', 'token_type_ids']),
    type: z.literal('tensor(int64)'),
    shape: z.tuple([z.literal('batch_size'), z.literal('sequence_length')]),
  })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const EncodingManifestSchema = z
  .object({
    revision: z.literal('r2b-encoding/1'),
    model: z
      .object({
        id: z.literal('Xenova/bge-small-zh-v1.5'),
        revision: z.literal('75c43b069aac4d136ba6bc1122f995fedcfd2781'),
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            bytes: z.number().int().positive(),
            sha256: hash,
            license_evidence: z.literal('license-evidence.json'),
          })
          .strict(),
      )
      .length(7),
    graph: z
      .object({
        inputs: z.array(graphInput).length(3),
        outputs: z.tuple([
          z
            .object({
              name: z.literal('last_hidden_state'),
              type: z.literal('tensor(float)'),
              shape: z.tuple([
                z.literal('batch_size'),
                z.literal('sequence_length'),
                z.literal(512),
              ]),
            })
            .strict(),
        ]),
      })
      .strict(),
    encoding: z
      .object({
        normalization: z.tuple([
          z.literal('CRLF_to_LF'),
          z.literal('NFC'),
          z.literal('strip_ecmascript_whitespace'),
        ]),
        prefix: z.literal(''),
        special_tokens: z.literal(true),
        max_tokens: z.literal(256),
        truncate: z.literal(false),
        pooling: z.literal('last_hidden_state[:,0,:]'),
        dtype: z.literal('float32'),
        dimension: z.literal(512),
        normalization_output: z.literal('L2_float32'),
        batch_size: z.literal(1),
        provider: z.literal('CPUExecutionProvider'),
        execution_mode: z.literal('ORT_SEQUENTIAL'),
        intra_op_threads: z.literal(4),
        inter_op_threads: z.literal(1),
        sessions: z.literal(1),
        max_inflight: z.literal(2),
      })
      .strict(),
    dependencies: z.record(z.string().min(1)),
    license_evidence_sha256: hash,
    dependency_licenses_sha256: hash,
    license_status: z
      .object({
        base_model: z.literal('MIT'),
        quantized_distribution: z.literal('not_declared'),
        production_distribution_cleared: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      manifest.files.some((file, index) => {
        const expected = PINNED_ENCODING_FILES[index]!;
        return (
          file.path !== expected.path ||
          file.bytes !== expected.bytes ||
          file.sha256 !== expected.sha256
        );
      }) ||
      manifest.graph.inputs.some(
        (input, index) => input.name !== ['input_ids', 'attention_mask', 'token_type_ids'][index],
      )
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'encoding assets or graph differ from pinned bytes',
      });
    const dependencies = Object.keys(manifest.dependencies).map((name) => name.toLowerCase());
    if (
      ['fastapi', 'uvicorn', 'transformers', 'tokenizers', 'onnxruntime', 'numpy'].some(
        (name) => !dependencies.includes(name),
      )
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing runtime dependencies' });
  });
