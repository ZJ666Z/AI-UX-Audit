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

type AuditPayload = {
  decisionCard: DecisionCard;
  flowGraph: FlowGraph;
  visuals: VisualPayload[];
  frameMetrics: FrameMetrics[];
  flowMetrics: FlowMetrics;
};

type FrameMetrics = {
  frameId: string;
  frameName: string;
  inboundCount: number;
  outboundCount: number;
  danglingReactions: number;
  isEntryPoint: boolean;
  isExitPoint: boolean;
  isDeadEnd: boolean;
  interactiveNodeCount: number;
  decisionPointCount: number;
  frameArea: number;
};

type FlowMetrics = {
  totalFrames: number;
  totalTransitions: number;
  entryPoints: string[];
  exitPoints: string[];
  deadEnds: string[];
  mostConnectedFrame: string;
  leastConnectedFrame: string;
  totalDecisionPoints: number;
  totalDanglingReactions: number;
  happyPath: string[];
  cognitiveComplexityScore: number;
};

type AuditItem = {
  targetFrameName: string;
  critiqueType: string;
  severity?: string;
  impactedMetric?: string;
  causalMechanism?: string;
  guardrailRef?: string;
  suggestion?: string;
  provocativeQuestion: string;
};

type UIMessage =
  | { type: 'prepare-audit-payload'; decisionCard: DecisionCard }
  | { type: 'write-audit-feedback'; audits: AuditItem[] }
  // FOCUS_FRAME: { frameId } — pan viewport to the frame and select it
  | { type: 'FOCUS_FRAME'; frameId: string }
  // INSPECT_NODES: { frameId } — walk the frame's node tree; response is NODES_RESULT
  | { type: 'INSPECT_NODES'; frameId: string }
  // APPLY_NODE_CHANGE: { nodeId, changeType, value } — apply a property edit to a Figma node
  | { type: 'APPLY_NODE_CHANGE'; nodeId: string; changeType: string; value: Record<string, unknown> };

type StickyCapableFigma = PluginAPI & {
  createSticky?: () => StickyNode;
};

const FIGMA_UI_WIDTH = 440;
const FIGMA_UI_HEIGHT = 760;
const MAX_EXPORT_WIDTH = 512;

figma.showUI(__html__, { width: FIGMA_UI_WIDTH, height: FIGMA_UI_HEIGHT });
sendSelectionInfo();

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

const INTENTIONAL_EXIT_KEYWORDS = ['success', 'complete', 'done', 'confirm', 'thank', '成功', '完成', '确认', '谢谢'];

function isIntentionalExit(name: string): boolean {
  const lower = name.toLowerCase();
  return INTENTIONAL_EXIT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function computeHappyPath(
  adjacency: Map<string, string[]>,
  entryPoints: string[],
  deadEndSet: Set<string>,
  totalFrames: number,
  allFrameNames: string[]
): string[] {
  let bestPath: string[] = [];
  const startFrames = entryPoints.length > 0 ? entryPoints : allFrameNames.slice(0, 1);

  function dfs(current: string, path: string[], visited: Set<string>): void {
    if (path.length >= totalFrames) {
      if (!deadEndSet.has(current) && path.length > bestPath.length) bestPath = [...path];
      return;
    }
    const unvisited = (adjacency.get(current) || []).filter((n) => !visited.has(n));
    if (unvisited.length === 0) {
      if (!deadEndSet.has(current) && path.length > bestPath.length) bestPath = [...path];
      return;
    }
    for (const neighbor of unvisited) {
      visited.add(neighbor);
      dfs(neighbor, [...path, neighbor], visited);
      visited.delete(neighbor);
    }
  }

  for (const entry of startFrames) {
    const visited = new Set<string>([entry]);
    dfs(entry, [entry], visited);
  }
  return bestPath;
}

function computeGraphMetrics(flowGraph: FlowGraph): { frameMetrics: FrameMetrics[]; flowMetrics: FlowMetrics } {
  const { frames, nodes, edges } = flowGraph;

  const outboundNeighbors = new Map<string, Set<string>>();
  const inboundNeighbors  = new Map<string, Set<string>>();
  const danglingByFrame   = new Map<string, number>();

  for (const frame of frames) {
    outboundNeighbors.set(frame.name, new Set());
    inboundNeighbors.set(frame.name, new Set());
    danglingByFrame.set(frame.name, 0);
  }

  for (const edge of edges) {
    const src = edge.sourceFrameName;
    const dst = edge.destinationFrameName;
    if (dst === null) {
      danglingByFrame.set(src, (danglingByFrame.get(src) ?? 0) + 1);
    } else if (dst !== src) {
      outboundNeighbors.get(src)?.add(dst);
      inboundNeighbors.get(dst)?.add(src);
    }
  }

  const interactiveByFrame = new Map<string, number>();
  for (const frame of frames) interactiveByFrame.set(frame.name, 0);
  for (const node of nodes) {
    if (node.isInteractive) {
      interactiveByFrame.set(node.frameName, (interactiveByFrame.get(node.frameName) ?? 0) + 1);
    }
  }

  const frameMetrics: FrameMetrics[] = frames.map((frame) => {
    const outbound = outboundNeighbors.get(frame.name)!;
    const inbound  = inboundNeighbors.get(frame.name)!;
    const dangling = danglingByFrame.get(frame.name) ?? 0;
    const outboundCount = outbound.size;
    const inboundCount  = inbound.size;
    const isEntryPoint  = inboundCount === 0;
    const isExitPoint   = outboundCount === 0;
    const isDeadEnd     = isExitPoint && !isIntentionalExit(frame.name);
    return {
      frameId: frame.id,
      frameName: frame.name,
      inboundCount,
      outboundCount,
      danglingReactions: dangling,
      isEntryPoint,
      isExitPoint,
      isDeadEnd,
      interactiveNodeCount: interactiveByFrame.get(frame.name) ?? 0,
      decisionPointCount: outboundCount > 1 ? 1 : 0,
      frameArea: frame.width * frame.height,
    };
  });

  const entryPoints = frameMetrics.filter((f) => f.isEntryPoint).map((f) => f.frameName);
  const exitPoints  = frameMetrics.filter((f) => f.isExitPoint).map((f) => f.frameName);
  const deadEnds    = frameMetrics.filter((f) => f.isDeadEnd).map((f) => f.frameName);
  const totalDecisionPoints   = frameMetrics.reduce((s, f) => s + f.decisionPointCount, 0);
  const totalDanglingReactions = frameMetrics.reduce((s, f) => s + f.danglingReactions, 0);
  const totalTransitions = edges.filter((e) => e.destinationFrameName !== null && e.destinationFrameName !== e.sourceFrameName).length;

  let mostConnectedFrame = frames[0]?.name ?? '';
  let mostConnectedCount = -1;
  let leastConnectedFrame = frames[0]?.name ?? '';
  let leastConnectedTotal = Infinity;
  for (const fm of frameMetrics) {
    if (fm.inboundCount > mostConnectedCount) { mostConnectedCount = fm.inboundCount; mostConnectedFrame = fm.frameName; }
    const total = fm.inboundCount + fm.outboundCount;
    if (total < leastConnectedTotal) { leastConnectedTotal = total; leastConnectedFrame = fm.frameName; }
  }

  const adjacency = new Map<string, string[]>();
  for (const frame of frames) adjacency.set(frame.name, Array.from(outboundNeighbors.get(frame.name)!));

  const deadEndSet = new Set(deadEnds);
  const happyPath  = computeHappyPath(adjacency, entryPoints, deadEndSet, frames.length, frames.map((f) => f.name));

  const happyPathExtra = Math.max(0, happyPath.length - 5);
  const cognitiveComplexityScore = Math.max(0,
    100 - totalDecisionPoints * 3 - deadEnds.length * 5 - totalDanglingReactions * 2 - happyPathExtra,
  );

  return {
    frameMetrics,
    flowMetrics: {
      totalFrames: frames.length,
      totalTransitions,
      entryPoints,
      exitPoints,
      deadEnds,
      mostConnectedFrame,
      leastConnectedFrame,
      totalDecisionPoints,
      totalDanglingReactions,
      happyPath,
      cognitiveComplexityScore,
    },
  };
}

async function prepareAuditPayload(decisionCard: DecisionCard): Promise<AuditPayload> {
  const frames = getSelectedTopLevelFrames();
  if (frames.length === 0) {
    throw new Error('Please select one or more top-level FRAME nodes before auditing.');
  }

  const flowGraph = await buildFlowGraph(frames);
  const visuals   = await exportFrameVisuals(frames);
  const { frameMetrics, flowMetrics } = computeGraphMetrics(flowGraph);

  return {
    decisionCard,
    flowGraph,
    visuals,
    frameMetrics,
    flowMetrics,
  };
}

async function ensureTextFonts(): Promise<void> {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
}

function createStickyFallback(audit: AuditItem, frame: FrameNode, index: number): SceneNode {
  const note = figma.createFrame();
  note.name = `Audit - ${audit.targetFrameName}`;
  note.layoutMode = 'VERTICAL';
  note.primaryAxisSizingMode = 'AUTO';
  note.counterAxisSizingMode = 'FIXED';
  note.resize(260, 100);
  note.paddingTop = 16;
  note.paddingBottom = 16;
  note.paddingLeft = 16;
  note.paddingRight = 16;
  note.itemSpacing = 10;
  note.cornerRadius = 10;
  note.fills = [{ type: 'SOLID', color: { r: 1, g: 0.94, b: 0.9 } }];
  note.strokes = [{ type: 'SOLID', color: { r: 0.82, g: 0.32, b: 0.28 } }];
  note.x = frame.x + frame.width + 100;
  note.y = frame.y + index * 160;

  const title = figma.createText();
  title.fontName = { family: 'Inter', style: 'Bold' };
  title.fontSize = 12;
  title.characters = `${audit.critiqueType} | ${audit.targetFrameName}`;
  title.fills = [{ type: 'SOLID', color: { r: 0.65, g: 0.16, b: 0.15 } }];

  const body = figma.createText();
  body.fontName = { family: 'Inter', style: 'Regular' };
  body.fontSize = 14;
  body.characters = audit.provocativeQuestion;
  body.layoutAlign = 'STRETCH';
  body.fills = [{ type: 'SOLID', color: { r: 0.21, g: 0.16, b: 0.12 } }];

  note.appendChild(title);
  note.appendChild(body);

  if (audit.impactedMetric) {
    const metric = figma.createText();
    metric.fontName = { family: 'Inter', style: 'Bold' };
    metric.fontSize = 11;
    metric.characters = `📉 ${audit.impactedMetric}`;
    metric.fills = [{ type: 'SOLID', color: { r: 0.44, g: 0.18, b: 0.6 } }];
    note.appendChild(metric);
  }
  figma.currentPage.appendChild(note);
  return note;
}

function createStickyNote(audit: AuditItem, frame: FrameNode, index: number): SceneNode {
  const stickyApi = figma as StickyCapableFigma;
  if (typeof stickyApi.createSticky === 'function') {
    const sticky = stickyApi.createSticky();
    sticky.name = `Audit - ${audit.targetFrameName}`;
    sticky.x = frame.x + frame.width + 100;
    sticky.y = frame.y + index * 260;
    sticky.text.characters = `${audit.critiqueType}\n${audit.provocativeQuestion}`;
    sticky.fillStyleId = '';
    sticky.fills = [{ type: 'SOLID', color: { r: 1, g: 0.86, b: 0.42 } }];
    figma.currentPage.appendChild(sticky);
    return sticky;
  }

  return createStickyFallback(audit, frame, index);
}

async function writeAuditFeedback(audits: AuditItem[]): Promise<void> {
  const frames = getSelectedTopLevelFrames();
  if (frames.length === 0) {
    throw new Error('Selection changed. Please reselect the frames and run the audit again.');
  }

  await ensureTextFonts();

  const frameByName = new Map<string, FrameNode>();
  for (const frame of frames) {
    frameByName.set(frame.name, frame);
  }

  const createdNodes: SceneNode[] = [];
  const yOffsetByFrame = new Map<string, number>();

  for (const audit of audits) {
    const frame = frameByName.get(audit.targetFrameName) ?? frames[0];
    const currentIndex = yOffsetByFrame.get(frame.id) ?? 0;
    const created = createStickyNote(audit, frame, currentIndex);
    yOffsetByFrame.set(frame.id, currentIndex + 1);
    createdNodes.push(created);
  }

  if (createdNodes.length > 0) {
    figma.viewport.scrollAndZoomIntoView(createdNodes);
  }
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

    if (msg.type === 'write-audit-feedback') {
      await writeAuditFeedback(msg.audits);
      figma.notify('AI audit complete. Feedback has been placed next to the audited frames.');
      return;
    }

    if (msg.type === 'FOCUS_FRAME') {
      const node = await figma.getNodeByIdAsync(msg.frameId);
      if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
        const sceneNode = node as SceneNode;
        figma.currentPage.selection = [sceneNode];
        // Pan to center on the frame without changing zoom level, so nearby
        // sticky notes (placed to the right of the frame) stay visible
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
