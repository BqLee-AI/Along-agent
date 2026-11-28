package along_host

// Only these public route families may reach the product capability. The TS
// adapter applies the existing method, path validation and error precedence.
func isProductPath(path: String): Bool {
    match (path) {
        case "/api/v1/brief" | "/api/v1/workspaces" |
             "/api/v1/model-providers/actions/summarize-notes" => true
        case _ =>
            for (base in ["/api/v1/approvals", "/api/v1/document-approvals", "/api/v1/tasks",
                         "/api/v1/memories", "/api/v1/office/feishu/bot", "/api/v1/bots",
                         "/api/v1/skills", "/api/v1/news", "/api/v1/channels/wechat"]) {
                if (path == base || path.startsWith(base + "/")) { return true }
            }
            false
    }
}
