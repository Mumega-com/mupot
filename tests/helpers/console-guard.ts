import * as ts from 'typescript'

// AST scan for every use of the `console` identifier in a TypeScript source file.
// A regex over lines misses bracket access, callbacks, aliases, console.trace, and any line
// with a '/' before the call. Scanning identifier nodes catches all of those, and ignores
// the word inside strings, template text and comments (client-side <script> bodies are strings).
//
// A use is excused only by an `allow-raw-console` marker on the same line.
export function findConsoleUses(source: string, fileName = 'x.ts'): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lines = source.split('\n')
  const hits: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'console') {
      const parent = node.parent
      const viaGlobal = ts.isPropertyAccessExpression(parent) && parent.name === node
        && /^(globalThis|self|window|global)$/.test(parent.expression.getText(sf))
      const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node && !viaGlobal)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertySignature(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
      if (!isMemberName) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
        if (!(lines[line] ?? '').includes('allow-raw-console')) hits.push(line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}
