import modelWorker from '../../workers/model-precompute.js';

export const onRequest = (context) =>
  modelWorker.fetch(context.request, context.env, context);
