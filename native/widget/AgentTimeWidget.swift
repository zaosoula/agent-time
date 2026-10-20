import SwiftUI
import WidgetKit

struct SummaryEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct SummaryProvider: TimelineProvider {
    func placeholder(in context: Context) -> SummaryEntry {
        let now = Date()
        return SummaryEntry(date: now, snapshot: WidgetSnapshot(version: 1, date: WidgetSnapshot.dayString(now), updatedAt: now.timeIntervalSince1970, available: true, running: true, humanSeconds: 5400, agentSeconds: 7200, workingAgents: 2, hooksNeedUpdate: false, captureNeedsAttention: false))
    }

    func getSnapshot(in context: Context, completion: @escaping (SummaryEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : SummaryEntry(date: Date(), snapshot: WidgetSnapshot.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SummaryEntry>) -> Void) {
        let now = Date()
        let snapshot = WidgetSnapshot.read()
        var entries = [SummaryEntry(date: now, snapshot: snapshot)]
        if let snapshot {
            let expiration = Date(timeIntervalSince1970: snapshot.updatedAt + 15 * 60)
            if expiration > now { entries.append(SummaryEntry(date: expiration, snapshot: snapshot)) }
        }
        let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)) ?? now.addingTimeInterval(24 * 60 * 60)
        if midnight > now { entries.append(SummaryEntry(date: midnight, snapshot: snapshot)) }
        entries.sort { $0.date < $1.date }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(15 * 60))))
    }
}

struct SummaryWidgetView: View {
    let entry: SummaryEntry

    private var snapshot: WidgetSnapshot? {
        guard let value = entry.snapshot, value.isFresh(at: entry.date) else { return nil }
        return value
    }

    private var isUnavailable: Bool { snapshot?.available == false }

    private func duration(_ seconds: Double) -> String {
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(minutes)m" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline) {
                Label("Agent Time", systemImage: "clock")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                Spacer()
                Text("TODAY").font(.system(size: 10, weight: .semibold)).tracking(1.2).foregroundStyle(.secondary)
            }
            if let snapshot, snapshot.available {
                HStack(alignment: .top, spacing: 16) {
                    metric("Mac activity", duration(snapshot.humanSeconds), "Estimated")
                    metric("Agent time", duration(snapshot.agentSeconds), "Credited")
                    metric("Working now", String(snapshot.running ? snapshot.workingAgents : 0), snapshot.running ? "agents" : "Paused")
                }
                Spacer(minLength: 0)
                if snapshot.captureNeedsAttention == true {
                    Label(snapshot.hooksNeedUpdate == true ? "Hooks need update · agent time may be missing" : "Capture needs attention · open Agent Time", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                } else {
                    HStack {
                        Text(snapshot.running ? "Tracking activity" : "Tracking paused")
                        Spacer()
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                }
                Text("Updated \(Date(timeIntervalSince1970: snapshot.updatedAt), style: .time)")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            } else {
                Spacer(minLength: 0)
                Text(isUnavailable ? "Open Agent Time to check capture" : "Open Agent Time to refresh today’s summary")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.primary)
                Text(isUnavailable ? "Capture unavailable" : entry.snapshot == nil ? "No summary yet" : "Summary is out of date")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(URL(string: snapshot?.captureNeedsAttention == true ? "agenttime://capture-health/" : "agenttime://today/"))
    }

    private func metric(_ title: String, _ value: String, _ note: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            Text(value).font(.system(size: 24, weight: .semibold, design: .rounded)).minimumScaleFactor(0.75).lineLimit(1)
            Text(note).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        if #available(macOS 14.0, *) {
            content.containerBackground(for: .widget) { Color(nsColor: .windowBackgroundColor) }
        } else {
            content.background(Color(nsColor: .windowBackgroundColor))
        }
    }
}

@main
struct AgentTimeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: agentTimeWidgetKind, provider: SummaryProvider()) { entry in
            SummaryWidgetView(entry: entry)
        }
        .configurationDisplayName("Today’s work")
        .description("Mac activity, agent time, and agents working now.")
        .supportedFamilies([.systemMedium])
    }
}
