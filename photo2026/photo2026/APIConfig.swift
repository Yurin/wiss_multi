import Foundation

enum APIConfig {
    static var appBaseURL: URL { serverURL(defaults: .standard) }

    static func serverURL(defaults: UserDefaults) -> URL {
        // Keep the previous Settings key as a migration fallback for installed apps.
        let keys = ["WEB_APP_BASE_URL", "API_BASE_URL", "ServerBaseURL"]
        let values = keys.compactMap { defaults.string(forKey: $0) }
            + keys.compactMap { Bundle.main.object(forInfoDictionaryKey: $0) as? String }
        for value in values {
            guard var url = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
                  ["https", "http"].contains(url.scheme), url.host != nil else { continue }
            url.path = "/"
            url.query = nil
            url.fragment = nil
            if let result = url.url { return result }
        }
        return URL(string: "https://photo-interface.com")!
    }
}
