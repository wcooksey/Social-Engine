import { prisma } from '../config/database';

/**
 * Surgical playbook editing — the AI edits its own instructions like a code
 * editor: find an exact snippet and replace just that, without rewriting the
 * whole thing. Ambiguous or missing matches are rejected so edits are precise.
 */

export class PlaybookEditError extends Error {}

export async function strReplaceInPlaybook(
  organizationId: string,
  playbookId: string,
  find: string,
  replace: string
): Promise<{ before: string; after: string }> {
  const playbook = await prisma.playbook.findFirst({
    where: { id: playbookId, organizationId },
  });
  if (!playbook) throw new PlaybookEditError('Playbook not found');

  const occurrences = playbook.instructions.split(find).length - 1;
  if (occurrences === 0) {
    throw new PlaybookEditError(
      `The exact text to find was not present. Read the current instructions with list_playbooks and copy the snippet verbatim.`
    );
  }
  if (occurrences > 1) {
    throw new PlaybookEditError(
      `The text to find appears ${occurrences} times — include more surrounding context so it matches exactly one place.`
    );
  }

  const updated = playbook.instructions.replace(find, replace);
  await prisma.playbook.update({
    where: { id: playbook.id },
    data: { instructions: updated },
  });
  return { before: playbook.instructions, after: updated };
}

export async function appendToPlaybook(
  organizationId: string,
  playbookId: string,
  text: string
): Promise<string> {
  const playbook = await prisma.playbook.findFirst({
    where: { id: playbookId, organizationId },
  });
  if (!playbook) throw new PlaybookEditError('Playbook not found');
  const updated = `${playbook.instructions.trimEnd()}\n${text}`;
  await prisma.playbook.update({ where: { id: playbook.id }, data: { instructions: updated } });
  return updated;
}
