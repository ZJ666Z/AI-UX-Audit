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
  | { type: 'write-audit-feedback'; audits: AuditItem[] };

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

async function prepareAuditPayload(decisionCard: DecisionCard): Promise<AuditPayload> {
  const frames = getSelectedTopLevelFrames();
  if (frames.length === 0) {
    throw new Error('Please select one or more top-level FRAME nodes before auditing.');
  }

  const flowGraph = await buildFlowGraph(frames);
  const visuals = await exportFrameVisuals(frames);

  return {
    decisionCard,
    flowGraph,
    visuals,
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
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown plugin error.';
    figma.ui.postMessage({ type: 'error', message });
  }
};
