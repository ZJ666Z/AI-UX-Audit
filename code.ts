type DecisionCard = {
  decisionQuestion: string;
  businessGoal: string;
  businessMetrics: string[];
  experienceGoal: string;
  experienceMetrics: string[];
  drivingLogic: string;
  primaryMetric: string;
  guardrails: string[];
  constraints: string[];
  touchpoints: string[];
};

type FlowGraphNode = {
  id: string;
  name: string;
  type: SceneNode['type'];
  frameId: string;
  frameName: string;
  parentId: string | null;
  path: string[];
  isInteractive: boolean;
  reactions: FlowGraphEdge[];
  variantProperties?: Record<string, string>;
  componentProperties?: string[];
};

type FlowGraphEdge = {
  sourceNodeId: string;
  sourceNodeName: string;
  sourceFrameId: string;
  sourceFrameName: string;
  trigger: string;
  actionType: string;
  destinationId: string | null;
  destinationName: string | null;
  destinationFrameId: string | null;
  destinationFrameName: string | null;
};

type FlowGraphFrame = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  childIds: string[];
};

type FlowGraph = {
  frames: FlowGraphFrame[];
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
};

type VisualPayload = {
  frameId: string;
  name: string;
  base64: string;
};

// A single text node extracted up front so the whole flow's copy can be
// audited for cross-screen consistency in one pass. roleHint is inferred
// from font size + layer name so the LLM knows if copy is a heading, body,
// button, or caption without needing every screenshot.
type TextRecord = {
  nodeId: string;
  frameId: string;
  frameName: string;
  characters: string;
  fontSize: number | 'mixed';
  roleHint: string;
  // Text box width in px — lets the LLM judge whether a rewrite will still
  // fit the space the design allocates for this string.
  boxWidth: number;
};

type AuditPayload = {
  decisionCard: DecisionCard;
  flowGraph: FlowGraph;
  visuals: VisualPayload[];
  texts: TextRecord[];
};

type UIMessage =
  | { type: 'prepare-audit-payload'; decisionCard: DecisionCard }
  // FOCUS_FRAME: { frameId } — pan viewport to the frame and select it
  | { type: 'FOCUS_FRAME'; frameId: string }
  // INSPECT_NODES: { frameId } — walk the frame's node tree; response is NODES_RESULT
  | { type: 'INSPECT_NODES'; frameId: string }
  // APPLY_NODE_CHANGE: { nodeId, changeType, value } — apply a property edit to a Figma node
  | { type: 'APPLY_NODE_CHANGE'; nodeId: string; changeType: string; value: Record<string, unknown> }
  // SAVE_SNAPSHOT: { snapshots } — persist audit history to clientStorage
  | { type: 'SAVE_SNAPSHOT'; snapshots: unknown[] };

const FIGMA_UI_WIDTH = 440;
const FIGMA_UI_HEIGHT = 760;
const MAX_EXPORT_WIDTH = 512;

figma.showUI(__html__, { width: FIGMA_UI_WIDTH, height: FIGMA_UI_HEIGHT });
sendSelectionInfo();

// Load persisted audit history and send to the UI once it's ready
figma.clientStorage.getAsync('audit_history').then((data) => {
  if (Array.isArray(data) && data.length > 0) {
    figma.ui.postMessage({ type: 'HISTORY_LOADED', snapshots: data });
  }
}).catch(() => { /* storage unavailable — start fresh */ });

function isFrameNode(node: SceneNode): node is FrameNode {
  return node.type === 'FRAME';
}

function bytesToBase64(bytes: Uint8Array): string {
  return figma.base64Encode(bytes);
}

function getSelectedTopLevelFrames(): FrameNode[] {
  return figma.currentPage.selection.filter(isFrameNode);
}

function sendSelectionInfo(): void {
  const frames = getSelectedTopLevelFrames();
  const message =
    frames.length > 0
      ? `Ready to audit ${frames.length} selected frame${frames.length > 1 ? 's' : ''}.`
      : 'Select one or more top-level frames to build the audit payload.';

  figma.ui.postMessage({
    type: 'selection-info',
    frameNames: frames.map((frame) => frame.name),
    message,
  });
}

function getNodePath(node: SceneNode): string[] {
  const path: string[] = [];
  let current: BaseNode | null = node;

  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if ('name' in current) {
      path.unshift(current.name);
    }
    current = current.parent;
  }

  return path;
}

function getVariantProperties(node: SceneNode): Record<string, string> | undefined {
  if ('variantProperties' in node && node.variantProperties) {
    return node.variantProperties;
  }
  return undefined;
}

function getComponentProperties(node: SceneNode): string[] | undefined {
  if ('componentProperties' in node && node.componentProperties) {
    return Object.keys(node.componentProperties);
  }
  return undefined;
}

async function resolveDestinationFrame(
  destinationId: string | undefined,
  selectedFrameIds: Set<string>
): Promise<{ destinationNode: SceneNode | null; destinationFrame: FrameNode | null }> {
  if (!destinationId) {
    return { destinationNode: null, destinationFrame: null };
  }

  const destinationNode = await figma.getNodeByIdAsync(destinationId);
  if (!destinationNode || destinationNode.type === 'PAGE' || destinationNode.type === 'DOCUMENT') {
    return { destinationNode: null, destinationFrame: null };
  }

  let current: BaseNode | null = destinationNode;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if (current.type === 'FRAME' && selectedFrameIds.has(current.id)) {
      return {
        destinationNode,
        destinationFrame: current,
      };
    }
    current = current.parent;
  }

  return { destinationNode, destinationFrame: null };
}

async function collectNodeGraph(
  frame: FrameNode,
  selectedFrameIds: Set<string>
): Promise<{ nodes: FlowGraphNode[]; edges: FlowGraphEdge[] }> {
  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraphEdge[] = [];

  const visit = async (node: SceneNode, parentId: string | null): Promise<void> => {
    const reactions = 'reactions' in node ? node.reactions ?? [] : [];
    const graphEdges: FlowGraphEdge[] = [];

    for (const reaction of reactions) {
      const action = reaction.action;
      const destinationId = action && 'destinationId' in action ? action.destinationId ?? null : null;
      const { destinationNode, destinationFrame } = await resolveDestinationFrame(destinationId ?? undefined, selectedFrameIds);

      const edge: FlowGraphEdge = {
        sourceNodeId: node.id,
        sourceNodeName: node.name,
        sourceFrameId: frame.id,
        sourceFrameName: frame.name,
        trigger: reaction.trigger?.type ?? 'UNKNOWN_TRIGGER',
        actionType: action?.type ?? 'UNKNOWN_ACTION',
        destinationId,
        destinationName: destinationNode && 'name' in destinationNode ? destinationNode.name : null,
        destinationFrameId: destinationFrame?.id ?? null,
        destinationFrameName: destinationFrame?.name ?? null,
      };

      graphEdges.push(edge);
      edges.push(edge);
    }

    nodes.push({
      id: node.id,
      name: node.name,
      type: node.type,
      frameId: frame.id,
      frameName: frame.name,
      parentId,
      path: getNodePath(node),
      isInteractive: graphEdges.length > 0,
      reactions: graphEdges,
      variantProperties: getVariantProperties(node),
      componentProperties: getComponentProperties(node),
    });

    if ('children' in node) {
      for (const child of node.children) {
        await visit(child, node.id);
      }
    }
  };

  await visit(frame, null);
  return { nodes, edges };
}

async function buildFlowGraph(frames: FrameNode[]): Promise<FlowGraph> {
  const selectedFrameIds = new Set(frames.map((frame) => frame.id));
  const graphFrames: FlowGraphFrame[] = [];
  const graphNodes: FlowGraphNode[] = [];
  const graphEdges: FlowGraphEdge[] = [];

  for (const frame of frames) {
    const frameGraph = await collectNodeGraph(frame, selectedFrameIds);
    graphFrames.push({
      id: frame.id,
      name: frame.name,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      childIds: frameGraph.nodes.filter((node) => node.parentId === frame.id).map((node) => node.id),
    });
    graphNodes.push(...frameGraph.nodes);
    graphEdges.push(...frameGraph.edges);
  }

  return {
    frames: graphFrames,
    nodes: graphNodes,
    edges: graphEdges,
  };
}

async function exportFrameVisuals(frames: FrameNode[]): Promise<VisualPayload[]> {
  const visuals: VisualPayload[] = [];

  for (const frame of frames) {
    const bytes = await frame.exportAsync({
      format: 'PNG',
      constraint: { type: 'WIDTH', value: MAX_EXPORT_WIDTH },
    });
    visuals.push({
      frameId: frame.id,
      name: frame.name,
      base64: bytesToBase64(bytes),
    });
  }

  return visuals;
}

const BUTTON_NAME_HINTS = ['button', 'btn', 'cta', 'link', 'action'];
const MAX_TEXTS = 400;

// Infer a text node's role from its font size and layer name so the audit
// prompt can reason about copy hierarchy without a screenshot per node.
function inferRoleHint(node: TextNode): string {
  const lowerName = node.name.toLowerCase();
  if (BUTTON_NAME_HINTS.some((kw) => lowerName.includes(kw))) return 'button';
  const size = node.fontSize;
  if (size === figma.mixed) return 'body';
  if (size >= 20) return 'heading';
  if (size <= 12) return 'caption';
  return 'body';
}

// Walk every selected frame once and collect all TEXT nodes. This is the
// backbone of a content audit: the whole flow's copy is available to the LLM
// in a single pass, which is what makes cross-screen consistency checks
// (e.g. "Sign in" vs "Log in") possible.
function extractTexts(frames: FrameNode[]): TextRecord[] {
  const texts: TextRecord[] = [];

  const walk = (node: SceneNode, frame: FrameNode): void => {
    if (texts.length >= MAX_TEXTS) return;
    // Hidden layers are not part of the shipped UI — skip the whole subtree
    // so alternate states / stashed copy never pollute the audit.
    if (!node.visible) return;
    if (node.type === 'TEXT') {
      const tn = node as TextNode;
      const characters = tn.characters.trim();
      if (characters.length > 0) {
        texts.push({
          nodeId: tn.id,
          frameId: frame.id,
          frameName: frame.name,
          characters: tn.characters,
          fontSize: tn.fontSize === figma.mixed ? 'mixed' : tn.fontSize,
          roleHint: inferRoleHint(tn),
          boxWidth: Math.round(tn.width),
        });
      }
    }
    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        if (texts.length >= MAX_TEXTS) break;
        walk(child as SceneNode, frame);
      }
    }
  };

  for (const frame of frames) {
    for (const child of frame.children) {
      if (texts.length >= MAX_TEXTS) break;
      walk(child, frame);
    }
  }

  return texts;
}

async function prepareAuditPayload(decisionCard: DecisionCard): Promise<AuditPayload> {
  const frames = getSelectedTopLevelFrames();
  if (frames.length === 0) {
    throw new Error('Please select one or more top-level FRAME nodes before auditing.');
  }

  const flowGraph = await buildFlowGraph(frames);
  const visuals   = await exportFrameVisuals(frames);
  const texts     = extractTexts(frames);

  return {
    decisionCard,
    flowGraph,
    visuals,
    texts,
  };
}

figma.on('selectionchange', () => {
  sendSelectionInfo();
});

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    if (msg.type === 'prepare-audit-payload') {
      const payload = await prepareAuditPayload(msg.decisionCard);
      figma.ui.postMessage({
        type: 'audit-payload-ready',
        payload,
      });
      return;
    }

    if (msg.type === 'FOCUS_FRAME') {
      const node = await figma.getNodeByIdAsync(msg.frameId);
      if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
        const sceneNode = node as SceneNode;
        figma.currentPage.selection = [sceneNode];
        // Pan to center on the node without changing zoom level
        const bb = sceneNode.absoluteBoundingBox;
        if (bb) {
          figma.viewport.center = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
        }
      }
      return;
    }
    // INSPECT_NODES: walk the focused frame's node tree (depth-first, cap 60)
    if (msg.type === 'INSPECT_NODES') {
      // Own try/catch so any error still resolves the loading state in ui.html
      try {
        const baseNode = await figma.getNodeByIdAsync(msg.frameId);
        if (!baseNode || baseNode.type !== 'FRAME') {
          figma.ui.postMessage({ type: 'NODES_RESULT', frameId: msg.frameId, nodes: [], truncated: false });
          return;
        }
        const frame = baseNode as FrameNode;

        type NodeRecord = {
          id: string; name: string; type: string;
          characters?: string;
          fills: Array<{ type: string; color?: { r: number; g: number; b: number } }>;
          visible: boolean; width: number; height: number; parentName: string;
        };

        const collected: NodeRecord[] = [];
        const CAP = 60;
        let truncated = false;

        // Arrow function avoids block-scoped function declaration issues in strict ES6
        const walk = (node: SceneNode): void => {
          if (collected.length >= CAP) { truncated = true; return; }
          const bb = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
          const rawFills = 'fills' in node && node.fills !== figma.mixed
            ? (node.fills as readonly Paint[])
            : [];
          const fills = rawFills.map((f) => ({
            type: f.type,
            color: f.type === 'SOLID' ? (f as SolidPaint).color : undefined,
          }));
          collected.push({
            id: node.id, name: node.name, type: node.type,
            characters: node.type === 'TEXT' ? (node as TextNode).characters : undefined,
            fills,
            visible: node.visible,
            width: bb?.width ?? 0, height: bb?.height ?? 0,
            parentName: node.parent && 'name' in node.parent ? (node.parent as { name: string }).name : '',
          });
          if ('children' in node) {
            for (const child of (node as FrameNode).children) {
              if (collected.length >= CAP) { truncated = true; break; }
              walk(child as SceneNode);
            }
          }
        };

        for (const child of frame.children) {
          if (collected.length >= CAP) { truncated = true; break; }
          walk(child);
        }

        figma.ui.postMessage({ type: 'NODES_RESULT', frameId: msg.frameId, nodes: collected, truncated });
      } catch (_err) {
        // Always send a result so ui.html never stays in the loading state
        figma.ui.postMessage({ type: 'NODES_RESULT', frameId: msg.frameId, nodes: [], truncated: false });
      }
      return;
    }

    // SAVE_SNAPSHOT: { snapshots } — persist audit run history to clientStorage
    if (msg.type === 'SAVE_SNAPSHOT') {
      figma.clientStorage.setAsync('audit_history', msg.snapshots).catch(() => {});
      return;
    }

    // APPLY_NODE_CHANGE: apply a property edit to a Figma node; posts NODE_CHANGE_APPLIED or NODE_CHANGE_FAILED
    if (msg.type === 'APPLY_NODE_CHANGE') {
      try {
        const baseNode = await figma.getNodeByIdAsync(msg.nodeId);
        if (!baseNode) {
          figma.ui.postMessage({ type: 'NODE_CHANGE_FAILED', nodeId: msg.nodeId, reason: 'Node not found' });
          return;
        }

        switch (msg.changeType) {
          case 'text_content': {
            if (baseNode.type !== 'TEXT') break;
            const tn = baseNode as TextNode;
            const fonts = new Set<string>();
            for (let i = 0; i < tn.characters.length; i++) {
              const f = tn.getRangeFontName(i, i + 1);
              if (f !== figma.mixed) fonts.add(JSON.stringify(f));
            }
            if (fonts.size === 0) fonts.add(JSON.stringify({ family: 'Inter', style: 'Regular' }));
            await Promise.all([...fonts].map((f) => figma.loadFontAsync(JSON.parse(f) as FontName)));
            tn.characters = String(msg.value.newText ?? '');
            break;
          }
          case 'fill_color': {
            const r = Number(msg.value.r ?? 0);
            const g = Number(msg.value.g ?? 0);
            const b = Number(msg.value.b ?? 0);
            if ('fills' in baseNode) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (baseNode as any).fills = [{ type: 'SOLID', color: { r, g, b }, opacity: 1 }];
            }
            break;
          }
          case 'visibility': {
            if ('visible' in baseNode) {
              (baseNode as SceneNode).visible = Boolean(msg.value.visible);
            }
            break;
          }
          case 'layout': {
            if (baseNode.type !== 'FRAME' && baseNode.type !== 'COMPONENT' && baseNode.type !== 'INSTANCE') break;
            const n = baseNode as FrameNode;
            const v = msg.value;
            if (v.layoutMode            !== undefined) n.layoutMode            = v.layoutMode as 'NONE' | 'HORIZONTAL' | 'VERTICAL';
            if (v.primaryAxisAlignItems !== undefined) n.primaryAxisAlignItems = v.primaryAxisAlignItems as 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN';
            if (v.counterAxisAlignItems !== undefined) n.counterAxisAlignItems = v.counterAxisAlignItems as 'MIN' | 'MAX' | 'CENTER' | 'BASELINE';
            if (v.paddingTop    !== undefined) n.paddingTop    = Number(v.paddingTop);
            if (v.paddingBottom !== undefined) n.paddingBottom = Number(v.paddingBottom);
            if (v.paddingLeft   !== undefined) n.paddingLeft   = Number(v.paddingLeft);
            if (v.paddingRight  !== undefined) n.paddingRight  = Number(v.paddingRight);
            if (v.itemSpacing   !== undefined) n.itemSpacing   = Number(v.itemSpacing);
            break;
          }
          case 'position': {
            if ('x' in baseNode && 'y' in baseNode) {
              (baseNode as SceneNode & { x: number; y: number }).x = Number(msg.value.x ?? 0);
              (baseNode as SceneNode & { x: number; y: number }).y = Number(msg.value.y ?? 0);
            }
            break;
          }
        }

        figma.ui.postMessage({ type: 'NODE_CHANGE_APPLIED', nodeId: msg.nodeId, changeType: msg.changeType });
      } catch (applyErr) {
        figma.ui.postMessage({
          type: 'NODE_CHANGE_FAILED',
          nodeId: msg.nodeId,
          reason: applyErr instanceof Error ? applyErr.message : 'Apply failed',
        });
      }
      return;
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown plugin error.';
    figma.ui.postMessage({ type: 'error', message });
  }
};
