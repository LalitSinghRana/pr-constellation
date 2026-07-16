import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";

const kindLabels = {
  core: "Core",
  supporting: "Supporting",
  downstream: "Downstream",
  validation: "Validation",
  mechanical: "Mechanical",
  risk: "Risk",
};

const kindColors = {
  core: "#0f766e",
  supporting: "#2563eb",
  downstream: "#7c3aed",
  validation: "#15803d",
  mechanical: "#64748b",
  risk: "#b42318",
};

const nodeTypes = {
  changeNode: ChangeNode,
};

function ChangeNode({ data, selected }) {
  const color = kindColors[data.kind] || "#475569";

  return (
    <div className={`graph-node ${selected ? "is-selected" : ""}`} style={{ "--node-accent": color }}>
      <Handle type="target" position={Position.Left} />
      <div className="graph-node-topline">
        <span className="graph-node-kind">{kindLabels[data.kind] || data.kind}</span>
        <span className="graph-node-depth">D{data.depth}</span>
      </div>
      <div className="graph-node-title">{data.title}</div>
      <div className="graph-node-comment">{data.comment}</div>
      <div className="graph-node-footer">
        <span>{Math.round((data.confidence ?? 0) * 100)}% confidence</span>
        <span>{data.evidence?.length || 0} evidence</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function App() {
  const analysis = readAnalysis();
  const [selected, setSelected] = useState({ type: "summary", value: analysis });
  const graph = useMemo(() => buildGraph(analysis), [analysis]);

  return (
    <ReactFlowProvider>
      <div className="graph-layout">
        <div className="graph-canvas" aria-label="PR change graph">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.2}
            maxZoom={1.4}
            onNodeClick={(_, node) => setSelected({ type: "node", value: node.data.raw })}
            onEdgeClick={(_, edge) => setSelected({ type: "edge", value: edge.data.raw })}
            onPaneClick={() => setSelected({ type: "summary", value: analysis })}
          >
            <Background gap={24} color="#e2e8f0" />
            <MiniMap nodeColor={(node) => kindColors[node.data.kind] || "#64748b"} pannable zoomable />
            <Controls />
          </ReactFlow>
        </div>
        <GraphDetails selected={selected} analysis={analysis} setSelected={setSelected} />
      </div>
    </ReactFlowProvider>
  );
}

function GraphDetails({ selected, analysis, setSelected }) {
  if (selected.type === "node") {
    return <NodeDetails node={selected.value} />;
  }

  if (selected.type === "edge") {
    return <EdgeDetails edge={selected.value} analysis={analysis} />;
  }

  return (
    <aside className="graph-details" aria-label="Graph summary">
      <div className="details-eyebrow">Graph Summary</div>
      <h2>{analysis.intent}</h2>
      <p>{analysis.summary}</p>
      <dl className="details-stats">
        <div>
          <dt>Nodes</dt>
          <dd>{analysis.nodes.length}</dd>
        </div>
        <div>
          <dt>Edges</dt>
          <dd>{analysis.edges.length}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{Math.round((analysis.confidence ?? 0) * 100)}%</dd>
        </div>
      </dl>
      <div className="edge-list">
        <h3>Edges</h3>
        {analysis.edges.map((edge) => (
          <button
            className="edge-list-item"
            key={`${edge.from}-${edge.to}-${edge.relation}`}
            type="button"
            onClick={() => setSelected({ type: "edge", value: edge })}
          >
            <span>{titleForNode(analysis, edge.from)}{" -> "}{titleForNode(analysis, edge.to)}</span>
            <strong>{edge.relation}</strong>
          </button>
        ))}
      </div>
    </aside>
  );
}

function NodeDetails({ node }) {
  return (
    <aside className="graph-details" aria-label="Node details">
      <div className="details-eyebrow">{kindLabels[node.kind] || node.kind} · depth {node.depth}</div>
      <h2>{node.title}</h2>
      <p>{node.comment}</p>
      <dl className="details-stats">
        <div>
          <dt>Confidence</dt>
          <dd>{Math.round((node.confidence ?? 0) * 100)}%</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{node.evidence.length}</dd>
        </div>
      </dl>
      <h3>Evidence</h3>
      <div className="evidence-list">
        {node.evidence.map((item, index) => (
          <button className="evidence-item" key={`${item.file}-${index}`} type="button" onClick={() => scrollToDiffFile(item.file)}>
            <span className="evidence-file">{item.file}</span>
            {item.hunk ? <span className="evidence-hunk">{item.hunk}</span> : null}
            <code>{item.excerpt}</code>
          </button>
        ))}
      </div>
    </aside>
  );
}

function EdgeDetails({ edge, analysis }) {
  return (
    <aside className="graph-details" aria-label="Edge details">
      <div className="details-eyebrow">Edge</div>
      <h2>{edge.relation}</h2>
      <p>{edge.comment}</p>
      <div className="edge-endpoints">
        <div>
          <span>From</span>
          <strong>{titleForNode(analysis, edge.from)}</strong>
        </div>
        <div>
          <span>To</span>
          <strong>{titleForNode(analysis, edge.to)}</strong>
        </div>
      </div>
    </aside>
  );
}

function buildGraph(analysis) {
  const depthCounts = new Map();
  const nodes = analysis.nodes.map((node) => {
    const depth = node.depth ?? 0;
    const indexInDepth = depthCounts.get(depth) || 0;
    depthCounts.set(depth, indexInDepth + 1);

    return {
      id: node.id,
      type: "changeNode",
      position: {
        x: depth * 420,
        y: indexInDepth * 230,
      },
      data: {
        ...node,
        raw: node,
      },
    };
  });

  const edges = analysis.edges.map((edge) => ({
    id: `${edge.from}->${edge.to}:${edge.relation}`,
    source: edge.from,
    target: edge.to,
    label: edge.relation,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 18,
      height: 18,
    },
    style: {
      stroke: "#64748b",
      strokeWidth: 2,
    },
    labelBgPadding: [8, 5],
    labelBgBorderRadius: 4,
    labelBgStyle: {
      fill: "#ffffff",
      fillOpacity: 0.95,
    },
    data: {
      raw: edge,
    },
  }));

  return { nodes, edges };
}

function readAnalysis() {
  const element = document.getElementById("pr-analysis-data");
  if (!element) {
    throw new Error("Missing PR graph analysis data.");
  }
  return JSON.parse(element.textContent);
}

function titleForNode(analysis, nodeId) {
  return analysis.nodes.find((node) => node.id === nodeId)?.title || nodeId;
}

function scrollToDiffFile(file) {
  const names = [...document.querySelectorAll(".d2h-file-name")];
  const match = names.find((element) => element.textContent.trim() === file);
  const target = match?.closest(".d2h-file-wrapper") || match;

  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("is-diff-highlighted");
    window.setTimeout(() => target.classList.remove("is-diff-highlighted"), 1600);
  }
}

const root = createRoot(document.getElementById("pr-graph-root"));
root.render(<App />);
