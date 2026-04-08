export default function HomePage() {
  return (
    <main className="home-shell">
      <div className="home-card">
        <p className="eyebrow">
            DB-MCP
          </p>
          <h1>
            Database MCP server with local and hosted entrypoints.
          </h1>
          <p className="lede">
            This deployment exposes the MCP API for hosted use, while the same tool set also ships as a local stdio launcher for Claude Desktop.
          </p>

          <div className="feature-grid">
            <div className="feature">Hosted MCP endpoint at /api/mcp</div>
            <div className="feature">Local stdio launcher for Claude Desktop</div>
            <div className="feature">Read-only database tools with row caps and timeout safeguards</div>
            <div className="feature">Allowlisted GitHub read-only tools</div>
          </div>

          <div className="footer-row">
            <span>Hosted route: <strong>/api/mcp</strong></span>
            <span>Local launcher: <strong>dist/mcp-stdio.mjs</strong></span>
          </div>
        </div>
    </main>
  );
}
