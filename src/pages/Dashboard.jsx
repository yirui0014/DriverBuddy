/**
 * ================================================================
 * File: Dashboard.jsx
 * Purpose:
 *   Provides the educational analytics dashboard showing Malaysian
 *   road-safety insights. Visualizes multiple datasets:
 *     - National accident trends (AreaChart)
 *     - State rankings (Treemap)
 *     - Top accident causes (PieChart)
 *     - Accidents by road type (PieChart by selected state)
 *     - Fatigue factors (Word Cloud)
 *
 * Data Sources:
 *   Fetched from backend API endpoints such as:
 *     /api/national-trends, /api/state-treemap, /api/top-causes,
 *     /api/states, /api/road-type, /api/fatigue-factors
 *
 * Libraries:
 *   - Recharts for charts and treemap.
 *   - react-d3-cloud for fatigue word cloud.
 *   - ResponsiveContainer for scaling across screen sizes.
 *
 * Integration:
 *   Accessible via “/dashboard” route to inform drivers
 *   and users with aggregated statistics and awareness insights.
 * ================================================================
 */
import "./Dashboard.css";
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip as LineTooltip, Legend,
  Treemap, Tooltip as TreeTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Tooltip as PieTooltip
} from "recharts";
import WordCloud from "react-d3-cloud";
import { useEffect, useState, useMemo, useCallback } from "react";
import { API_BASE } from "./config"; 

export default function Dashboard() {
  const [trends, setTrends] = useState([]);
  const [treemap, setTreemap] = useState([]);
  const [causes, setCauses] = useState([]);
  const [states, setStates] = useState([]);
  const [roadData, setRoadData] = useState([]);
  const [fatigue, setFatigue] = useState([]);
  const [selectedState, setSelectedState] = useState("All Malaysia");

  // Multicolor palette inspired by the provided word cloud (bright, friendly)
  const pieColors = [
    "#3B82F6", // blue
    "#22D3EE", // cyan
    "#34D399", // teal/green
    "#F59E0B", // amber
    "#FB923C", // orange
    "#EF4444", // coral/red
    "#F472B6", // pink
    "#A78BFA", // violet
  ];

  // Custom Treemap cell
  const TreemapCell = (props) => {
    const { x, y, width, height, name, payload, value, colorScale } = props;
    const raw = String(name || payload?.state || "").trim();
    const cx = x + width / 2;
    const cy = y + height / 2;
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} fill={colorScale(value, raw)} stroke="#ffffff" />
        {width > 40 && height > 20 && (
          <text
            x={cx}
            y={cy}
            fill="white"
            fontSize={12}
            fontWeight={700}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {raw}
          </text>
        )}
      </g>
    );
  };

  // Treemap tooltip
  const TreemapTooltip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload;
    return (
      <div className="tooltip">
        <div className="tooltip-title">{d.state}</div>
        <div>Accidents: {d.total_accidents}</div>
        <div>Population: {d.population}</div>
        <div>Rate: {d.accidents_per_100k} per 100k</div>
      </div>
    );
  };

  // Top causes tooltip
  const TopCausesTooltip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;
    return <div className="tooltip">{payload[0].payload.tip}</div>;
  };

  // Fetch data
  useEffect(() => {
    fetch(`${API_BASE}/api/national-trends`)
      .then(r => r.json())
      .then(d => setTrends(d.map(x => ({ ...x, year: String(x.year) }))));

    fetch(`${API_BASE}/api/state-treemap`)
      .then(r => r.json())
      .then(d => setTreemap(d));

    fetch(`${API_BASE}/api/top-causes`)
      .then(r => r.json())
      .then(setCauses);

    fetch(`${API_BASE}/api/states`)
      .then(r => r.json())
      .then(setStates);

    fetch(`${API_BASE}/api/fatigue-factors`)
      .then(r => r.json())
      .then(setFatigue);
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/road-type?state=${encodeURIComponent(selectedState)}`)
      .then(r => r.json())
      .then(d => setRoadData(d.data || d));
  }, [selectedState]);

  // Treemap colors using the same palette, but softened with alpha like the area chart
  function hexToRgba(hex, alpha = 0.65) {
    const m = String(hex).replace('#','');
    const n = m.length === 3
      ? m.split('').map(ch => ch + ch).join('')
      : m;
    const r = parseInt(n.slice(0,2), 16);
    const g = parseInt(n.slice(2,4), 16);
    const b = parseInt(n.slice(4,6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const treemapPalette = pieColors; // reuse chart palette for consistency
  const colorScale = useCallback((_, label) => {
    const s = String(label || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const idx = h % treemapPalette.length;
    return hexToRgba(treemapPalette[idx], 0.6); // slight transparency
  }, [treemapPalette]);

  // Total for road type percentage labels
  const totalRoadAccidents = useMemo(
    () => (roadData || []).reduce((sum, x) => sum + Number(x?.accidents || 0), 0),
    [roadData]
  );

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h2 className="dashboard-subtitle">Educational Dashboard</h2>
      </header>

      <div className="dashboard-content">
        {/* National Trends */}
        <div className="chart-card">
          <div className="card-head">
            <h3 className="card-title">National Accident Trends</h3>
          </div>
          <ResponsiveContainer width="100%" height={450}>
            <AreaChart data={trends}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="year" />
              <YAxis />
              <LineTooltip />
              <Legend />
              <Area type="monotone" dataKey="deaths" stackId="1" stroke="#e63946" fill="#e63946" />
              <Area type="monotone" dataKey="seriousAccidents" stackId="1" stroke="#fca311" fill="#fca311" />
              <Area type="monotone" dataKey="minorAccidents" stackId="1" stroke="#06d6a0" fill="#06d6a0" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* State Treemap */}
        <div className="chart-card">
          <div className="card-head">
            <h3 className="card-title">State Ranking by Accidents</h3>
          </div>
          <ResponsiveContainer width="100%" height={520}>
            <Treemap
              data={treemap}
              dataKey="accidents_per_100k"
              nameKey="state"
              content={(p) => <TreemapCell {...p} colorScale={colorScale} />}
            >
              <TreeTooltip content={<TreemapTooltip />} />
            </Treemap>
          </ResponsiveContainer>
        </div>

        {/* Causes (vertical stack) */}
        <div className="chart-card">
          <div className="card-head">
            <h3 className="card-title">Top Causes of Accidents</h3>
          </div>
          <ResponsiveContainer width="100%" height={520}>
            <PieChart>
              <Pie
                data={causes}
                dataKey="percentage"
                nameKey="cause"
                innerRadius={60}
                outerRadius={120}
                label={({ name, value }) => `${name}: ${value.toFixed(1)}%`}
              >
                {causes.map((_, i) => <Cell key={i} fill={pieColors[i % pieColors.length]} />)}
              </Pie>
              <PieTooltip content={<TopCausesTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Road type (below causes) */}
        <div className="chart-card">
          <div className="card-head">
            <h3 className="card-title">Accidents by Road Type</h3>
            <select className="card-select" value={selectedState} onChange={(e) => setSelectedState(e.target.value)}>
              {states.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <ResponsiveContainer width="100%" height={520}>
            <PieChart>
              <Pie
                data={roadData}
                dataKey="accidents"
                nameKey="roadType"
                innerRadius={60}
                outerRadius={120}
                label={({ name, value }) => {
                  const pct = totalRoadAccidents > 0 ? (value / totalRoadAccidents) * 100 : 0;
                  return `${name}: ${pct.toFixed(1)}%`;
                }}
              >
                {roadData.map((_, i) => <Cell key={i} fill={pieColors[i % pieColors.length]} />)}
              </Pie>
              <PieTooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Word Cloud */}
        <div className="chart-card wordcloud">
          <div className="card-head">
            <h3 className="card-title">Fatigue Factors</h3>
          </div>
          <WordCloud
            data={fatigue.map(f => ({ text: f.factor, value: f.percentage }))}
            width={900}
            height={420}
            font="Impact"
            fontWeight="900"
            fontSize={(w) => 14 + w.value * 1.2}
            rotate={(w, i) => [0, 0, 90, 0, -90][i % 5]}
            padding={2}
            spiral="rectangular"
          />
        </div>

        <footer className="dashboard-footer">
          Data sources: MIROS / JPJ (2011–2019); DOSM population.  
          <a href="https://open.dosm.gov.my/data-catalogue/population_state?state=melaka&visual=table" target="_blank" rel="noreferrer">Link</a>
        </footer>
      </div>
    </div>
  );
}
