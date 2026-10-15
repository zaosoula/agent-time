import Foundation
import ServiceManagement

@available(macOS 13.0, *)
func serviceStatus(_ service: SMAppService) -> String {
    switch service.status {
    case .enabled: return "enabled"
    case .requiresApproval: return "requiresApproval"
    case .notRegistered: return "notRegistered"
    case .notFound: return "notFound"
    @unknown default: return "unknown"
    }
}

func launchDashboardInBackground() throws {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    guard app.pathExtension == "app" else { throw NSError(domain: "AgentTimeStartup", code: 1, userInfo: [NSLocalizedDescriptionKey: "Startup helper is outside Agent Time.app"]) }
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-g", "-a", app.path, "--args", "--background"]
    try open.run()
    open.waitUntilExit()
    if open.terminationStatus != 0 { throw NSError(domain: "AgentTimeStartup", code: Int(open.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "Could not start Agent Time in the background"]) }
}

do {
    let command = CommandLine.arguments.dropFirst().first ?? "launch"
    if command == "launch" {
        try launchDashboardInBackground()
    } else if #available(macOS 13.0, *) {
        let service = SMAppService.agent(plistName: "studio.ezyo.agenttime.startup.plist")
        switch command {
        case "enable":
            if service.status == .notRegistered || service.status == .notFound { try service.register() }
        case "disable":
            if service.status != .notRegistered && service.status != .notFound { try service.unregister() }
        case "settings":
            SMAppService.openSystemSettingsLoginItems()
        case "status": break
        default: throw NSError(domain: "AgentTimeStartup", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unknown startup operation"])
        }
        let data = try JSONSerialization.data(withJSONObject: ["status": serviceStatus(service)])
        FileHandle.standardOutput.write(data)
    } else {
        throw NSError(domain: "AgentTimeStartup", code: 3, userInfo: [NSLocalizedDescriptionKey: "Login items require macOS 13 or later"])
    }
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
