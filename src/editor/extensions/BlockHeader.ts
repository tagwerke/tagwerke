// Detects "block header" paragraphs in the Today doc, paints the project
// accent across each block region via decorations, and normalizes the leading
// time token when the cursor leaves a header line.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useStore } from '../../store';
import { parseHeader, isHeaderText } from '../../util/header';
import type { ID } from '../../types';

export const blockHeaderKey = new PluginKey<BlockHeaderState>('today-block-header');

interface BlockRegion {
  headerPos: number;
  headerSize: number;
  start?: string;
  end?: string;
  tabId?: ID;
  projectColor: string;
  childRanges: Array<{ pos: number; size: number }>;
}

export interface BlockHeaderState {
  decorations: DecorationSet;
  /** Top-level paragraph position the selection is currently inside, if it's a header. */
  selectionHeaderPos: number | null;
  /** Cached regions for the current doc. */
  regions: BlockRegion[];
}

function computeRegions(state: EditorState): BlockRegion[] {
  const { tabs, projects, tabOrder } = useStore.getState();
  const regions: BlockRegion[] = [];
  let current: BlockRegion | null = null;
  state.doc.forEach((node: PMNode, offset: number) => {
    if (node.type.name === 'paragraph') {
      const parsed = parseHeader(node.textContent, tabs, projects, tabOrder);
      if (parsed.isHeader) {
        const tab = parsed.tabId ? tabs[parsed.tabId] : undefined;
        const proj = tab ? projects[tab.projectId] : undefined;
        const accent = proj?.color ?? '#888';
        current = {
          headerPos: offset,
          headerSize: node.nodeSize,
          start: parsed.start,
          end: parsed.end,
          tabId: parsed.tabId,
          projectColor: accent,
          childRanges: [],
        };
        regions.push(current);
        return;
      }
    }
    if (current) {
      current.childRanges.push({ pos: offset, size: node.nodeSize });
    }
  });
  return regions;
}

function buildDecorations(state: EditorState, regions: BlockRegion[]): DecorationSet {
  const decos: Decoration[] = [];
  for (const r of regions) {
    decos.push(
      Decoration.node(r.headerPos, r.headerPos + r.headerSize, {
        class: r.tabId ? 'today-header bound' : 'today-header',
        style: `--block-accent: ${r.projectColor}`,
      }),
    );
    for (const c of r.childRanges) {
      decos.push(
        Decoration.node(c.pos, c.pos + c.size, {
          class: 'today-in-block',
          style: `--block-accent: ${r.projectColor}`,
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decos);
}

function selectionHeaderPos(state: EditorState): number | null {
  const $from = state.selection.$from;
  if ($from.depth < 1) return null;
  // Find the top-level ancestor.
  const topNodePos = $from.before(1);
  const topNode = state.doc.nodeAt(topNodePos);
  if (!topNode || topNode.type.name !== 'paragraph') return null;
  if (!isHeaderText(topNode.textContent)) return null;
  return topNodePos;
}

export const BlockHeader = Extension.create({
  name: 'todayBlockHeader',
  addProseMirrorPlugins() {
    return [
      new Plugin<BlockHeaderState>({
        key: blockHeaderKey,
        state: {
          init: (_config, state) => {
            const regions = computeRegions(state);
            return {
              decorations: buildDecorations(state, regions),
              selectionHeaderPos: selectionHeaderPos(state),
              regions,
            };
          },
          apply: (tr, prev, _oldState, newState) => {
            const recompute = tr.docChanged || tr.getMeta('todayRecompute') === true;
            let regions = prev.regions;
            let decorations = prev.decorations;
            if (recompute) {
              regions = computeRegions(newState);
              decorations = buildDecorations(newState, regions);
            }
            return {
              decorations,
              selectionHeaderPos: selectionHeaderPos(newState),
              regions,
            };
          },
        },
        props: {
          decorations(state) {
            return blockHeaderKey.getState(state)?.decorations;
          },
        },
        appendTransaction: (transactions, oldState, newState) => {
          const oldS = blockHeaderKey.getState(oldState);
          if (!oldS || oldS.selectionHeaderPos === null) return null;

          let mapped = oldS.selectionHeaderPos;
          for (const tr of transactions) mapped = tr.mapping.map(mapped);

          const node = newState.doc.nodeAt(mapped);
          if (!node || node.type.name !== 'paragraph') return null;

          // Still inside the same paragraph? then don't normalize yet.
          const $from = newState.selection.$from;
          if ($from.depth >= 1 && $from.before(1) === mapped) return null;

          const text = node.textContent;
          const { tabs, projects, tabOrder } = useStore.getState();
          const parsed = parseHeader(text, tabs, projects, tabOrder);
          if (!parsed.isHeader || !parsed.normalizedToken) return null;
          const currentToken = text.slice(0, parsed.tokenLen);
          if (currentToken === parsed.normalizedToken) return null;

          const innerFrom = mapped + 1;
          const innerTo = innerFrom + parsed.tokenLen;
          const tr = newState.tr.replaceWith(
            innerFrom,
            innerTo,
            newState.schema.text(parsed.normalizedToken),
          );
          tr.setMeta('externalEdit', true);
          return tr;
        },
      }),
    ];
  },
});
