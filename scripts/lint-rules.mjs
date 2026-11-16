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
    'no-feature-view-fetch': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          fetch: 'Feature views MUST NOT fetch directly; data access belongs in model/viewmodel.',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const { callee } = node;
            const directFetch = callee.type === 'Identifier' && callee.name === 'fetch';
            const globalFetch =
              callee.type === 'MemberExpression' &&
              callee.object.type === 'Identifier' &&
              (callee.object.name === 'window' || callee.object.name === 'globalThis') &&
              ((!callee.computed &&
                callee.property.type === 'Identifier' &&
                callee.property.name === 'fetch') ||
                (callee.computed &&
                  callee.property.type === 'Literal' &&
                  callee.property.value === 'fetch'));
            if (directFetch || globalFetch) {
              context.report({ node, messageId: 'fetch' });
            }
          },
        };
      },
    },
  },
};
