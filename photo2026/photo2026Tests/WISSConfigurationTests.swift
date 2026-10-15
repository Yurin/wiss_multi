import Foundation
import Testing
@testable import photo2026

struct WISSConfigurationTests {
    @Test func settingsResolveTheSameOriginForHTTPAndWebSocket() {
        let suite = "WISSConfigurationTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("https://legacy.example/api", forKey: "ServerBaseURL")
        #expect(APIConfig.serverURL(defaults: defaults).absoluteString == "https://legacy.example/")
        defaults.set("http://localhost:3099/api?unused=1", forKey: "API_BASE_URL")
        #expect(APIConfig.serverURL(defaults: defaults).absoluteString == "http://localhost:3099/")
        defaults.set("https://booth.example/booth/#code", forKey: "WEB_APP_BASE_URL")
        #expect(APIConfig.serverURL(defaults: defaults).absoluteString == "https://booth.example/")
    }
}
