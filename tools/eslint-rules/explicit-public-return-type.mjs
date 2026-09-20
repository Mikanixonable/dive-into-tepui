/**
 * Enforce the return-type part of CODING-RULE 1.6 at public boundaries.
 *
 * This intentionally does not inspect every function argument. The generic
 * explicit-module-boundary-types rule is stricter than the repository rule.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'require return types on exported functions and public methods',
    },
    schema: [],
    messages: {
      missingReturnType: 'Exported functions and public/protected methods must declare a return type.',
    },
  },

  create(context) {
    const reportIfMissing = (node) => {
      if (!node.returnType) {
        context.report({ node, messageId: 'missingReturnType' });
      }
    };

    const reportExportedDeclaration = (declaration) => {
      if (!declaration) return;

      if (declaration.type === 'FunctionDeclaration') {
        reportIfMissing(declaration);
        return;
      }

      if (declaration.type !== 'VariableDeclaration') return;

      for (const declarator of declaration.declarations) {
        const initializer = declarator.init;
        if (initializer?.type === 'ArrowFunctionExpression' || initializer?.type === 'FunctionExpression') {
          reportIfMissing(initializer);
        }
      }
    };

    return {
      ExportNamedDeclaration(node) {
        reportExportedDeclaration(node.declaration);
      },

      ExportDefaultDeclaration(node) {
        reportExportedDeclaration(node.declaration);
      },

      MethodDefinition(node) {
        if (node.kind === 'constructor' || node.accessibility === 'private') return;
        reportIfMissing(node.value);
      },

      TSDeclareMethod(node) {
        if (node.accessibility !== 'private') reportIfMissing(node);
      },
    };
  },
};
