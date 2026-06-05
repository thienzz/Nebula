import { env } from '@huggingface/transformers';

// Cache downloaded weights inside the repo (gitignored) so reruns are offline + fast.
env.cacheDir = './.models-cache';
env.allowRemoteModels = true;
