export default {
  meta: { name: 'along-boundaries' },
  rules: {
    'no-web-time': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          construct: 'D2: apps/web MUST NOT construct Date (display layer does not compute time).',
          now: 'D2: apps/web MUST NOT call Date.now() (display layer does not compute time).',
        },
      },
      create(context) {
        return {
          "NewExpression[callee.name='Date']"(node) {
            context.report({ node, messageId: 'construct' });
          },
          "CallExpression[callee.object.name='Date'][callee.property.name='now']"(node) {
            context.report({ node, messageId: 'now' });
          },
        };
      },
    },
  },
};
