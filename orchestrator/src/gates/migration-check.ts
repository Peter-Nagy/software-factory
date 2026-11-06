/**
 * Gate 6: flag destructive database migrations so they wait for your approval on Discord.
 * Conservative on purpose: a false positive costs one tap, a false negative can cost data.
 */

export interface MigrationFinding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const RULES: { rule: string; re: RegExp }[] = [
  { rule: 'drop-table', re: /\bDROP\s+TABLE\b/i },
  { rule: 'drop-schema-or-database', re: /\bDROP\s+(SCHEMA|DATABASE)\b/i },
  { rule: 'drop-column', re: /\bDROP\s+COLUMN\b/i },
  { rule: 'drop-constraint-or-index', re: /\bDROP\s+(CONSTRAINT|INDEX)\b/i },
  { rule: 'truncate', re: /\bTRUNCATE\b/i },
  { rule: 'rename-column-or-table', re: /\bRENAME\s+(COLUMN|TO)\b/i },
  { rule: 'alter-column-type', re: /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i },
  { rule: 'set-not-null', re: /\bSET\s+NOT\s+NULL\b/i },
  { rule: 'drop-type', re: /\bDROP\s+TYPE\b/i },
  // ORM-generated JS/TS migrations
  { rule: 'orm-drop', re: /\.(dropTable|dropColumn|dropSchema|renameColumn|renameTable)\s*\(/ },
  // drizzle-kit / prisma data-loss warnings left in generated files
  { rule: 'orm-data-loss-warning', re: /data loss|will be lost|destructive/i },
];

const DELETE_RE = /\bDELETE\s+FROM\b/i;
const WHERE_RE = /\bWHERE\b/i;

function stripSqlComments(line: string): string {
  return line.replace(/--.*$/, '');
}

export function scanMigration(file: string, content: string): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const lines = content.split('\n');
  // Statements may span lines; check DELETE ... WHERE per statement.
  const statements = content.split(';');
  let offset = 0;
  for (const stmt of statements) {
    const clean = stmt.split('\n').map(stripSqlComments).join('\n');
    if (DELETE_RE.test(clean) && !WHERE_RE.test(clean)) {
      const at = offset + Math.max(stmt.search(DELETE_RE), 0);
      const line = content.slice(0, at).split('\n').length;
      findings.push({ file, line, rule: 'delete-without-where', text: clean.trim().slice(0, 120) });
    }
    offset += stmt.length + 1;
  }
  lines.forEach((raw, i) => {
    const isWarningRule = (r: string) => r === 'orm-data-loss-warning';
    for (const { rule, re } of RULES) {
      // Comments are ignored except for ORM data-loss warnings, which usually live in comments.
      const text = isWarningRule(rule) ? raw : stripSqlComments(raw).replace(/\/\/.*$/, '');
      if (re.test(text)) findings.push({ file, line: i + 1, rule, text: raw.trim().slice(0, 120) });
    }
  });
  return findings;
}

/** Minimal glob matcher for migration path patterns: supports **, * and ?. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function isMigrationFile(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function checkMigrations(files: { path: string; content: string }[], globs: string[]): MigrationFinding[] {
  return files.filter((f) => isMigrationFile(f.path, globs)).flatMap((f) => scanMigration(f.path, f.content));
}
