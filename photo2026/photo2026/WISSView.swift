import SwiftUI

struct WISSView: View {
    @StateObject private var model = WISSModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var code = ""
    @State private var showLibrary = false
    @State private var showConsent = false
    @State private var showPhotos = false
    @State private var research = false
    @State private var publication = false
    @State private var selectedReference: WISSReference?
    @State private var selectedVariant: WISSVariant?

    var body: some View {
        NavigationStack {
            Group {
                if let session = model.session {
                    VStack(spacing: 8) {
                        HStack {
                            Text(session.reference?.name ?? "自由撮影 / フレームなし").font(.headline)
                            Spacer()
                            Text("\(session.subjects.count)/6人 · \(model.isRepresentative ? "代表者" : "被写体") · \(model.connected ? "接続中" : "再接続中")").font(.caption)
                        }
                        HStack(spacing: 12) {
                            VStack(spacing: 4) {
                                Text("お手本写真").font(.caption)
                                picture {
                                    if let ref = session.reference { remoteImage(ref.imageURL) }
                                    else { Text("自由にポーズを取ってください").foregroundStyle(.white) }
                                }
                            }
                            VStack(spacing: 4) {
                                Text("撮影者の映像 ＋ フレーム").font(.caption)
                                picture {
                                    if let image = model.image { Image(uiImage: image).resizable().scaledToFit() }
                                    else { Text("映像を待っています").foregroundStyle(.white) }
                                    if let v = session.reference?.variants.first(where: { $0.id == session.activeFrameId }) { remoteImage(v.imageURL).opacity(0.65).allowsHitTesting(false) }
                                }
                            }
                        }.frame(maxHeight: .infinity)
                        if session.closed { Text("撮影は終了しました。写真を確認できます。").foregroundStyle(.secondary) }
                        HStack {
                            Button("フレームを選ぶ・提案") { showLibrary = true }
                            Button("同意を確認") { research = model.ownConsent?.research ?? false; publication = model.ownConsent?.publication ?? false; showConsent = true }
                            Button("撮影写真") { showPhotos = true }
                            if model.isRepresentative { Button("自由撮影") { Task { await model.activate(nil) } } }
                            if session.closed { Button("参加情報をリセット") { model.reset() } }
                        }.buttonStyle(.bordered)
                    }.padding(.horizontal, 16)
                } else {
                    VStack(spacing: 16) {
                        Text("WISS Multi").font(.title2.bold())
                        Text("撮影者画面の参加コードを入力してください")
                        TextField("参加コード", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().textFieldStyle(.roundedBorder).frame(maxWidth: 340).accessibilityIdentifier("wissJoinCode")
                        Button(model.credentials == nil ? "撮影に参加" : "セッションに再接続") { Task { if model.credentials == nil { await model.join(code: code) } else { await model.start() } } }.buttonStyle(.borderedProminent).disabled(model.busy)
                        if model.credentials != nil { Button("保存した参加情報をリセット") { model.reset() } }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { if !model.error.isEmpty { Text(model.error).font(.caption).foregroundStyle(.red).padding(4) } }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showConsent) { consentView }
            .sheet(isPresented: $showLibrary) { libraryView }
            .sheet(isPresented: $showPhotos) { photosView }
            .task { await model.start() }
            .onChange(of: model.ownConsent?.answered) { _, answered in if answered == false { research = false; publication = false; showConsent = true } }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.start() } } else { model.stop() } }
            .onOpenURL { url in
                guard url.scheme == "wissphoto", url.host == "join", model.credentials == nil else { return }
                code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value ?? ""
            }
        }
    }
    private func picture<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        Color.black.overlay { ZStack { content() } }.aspectRatio(4 / 3, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 10))
    }
    private func remoteImage(_ path: String, authenticated: Bool = false) -> some View {
        AsyncImage(url: model.url(path, authenticated: authenticated)) { image in image.resizable().scaledToFit() } placeholder: { ProgressView() }
    }
    private var consentView: some View {
        NavigationStack {
            Form {
                Section("この2つの同意は独立しています") {
                    Toggle("研究用Driveへの写真保存・研究利用に同意", isOn: $research)
                    Toggle("お手本写真・手描きフレームとして他の参加者への公開に同意", isOn: $publication)
                    Text("同意しなくても撮影できます。保存を選んだ写真はグループ共有用Driveへ保存されます。研究保存・公開再利用はそれぞれ全員の同意が必要です。変更は次に撮影する写真から反映されます。").font(.footnote)
                }
                Button("この内容で回答する") { Task { await model.perform("consent", body: ["research": research, "publication": publication]); if model.error.isEmpty { showConsent = false } } }.disabled(model.busy)
            }.navigationTitle("写真の利用について").toolbar { Button("閉じる") { showConsent = false } }
        }
    }
    private var libraryView: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let session = model.session, !session.proposals.isEmpty {
                        Text("グループからの提案").font(.headline)
                        ForEach(session.proposals, id: \.subjectId) { p in
                            HStack { Text("\(p.name) / \(p.kind)"); if model.isRepresentative { Button("この提案を確定") { Task { await model.activate(p.frameId); if model.error.isEmpty { showLibrary = false } } } } }
                        }
                    }
                    if model.library.isEmpty { Text("公開済みフレームはまだありません。自由撮影をご利用ください。") }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 190))]) {
                        ForEach(model.library) { ref in
                            Button { selectedReference = ref; selectedVariant = nil } label: {
                                VStack { remoteImage(ref.imageURL).aspectRatio(4 / 3, contentMode: .fit); Text("\(ref.name) · \(ref.subjectCount)人") }
                            }.buttonStyle(.plain)
                        }
                    }
                    if let ref = selectedReference {
                        Text("\(ref.name)：フレーム種類を選択").font(.headline)
                        HStack {
                            ForEach(ref.variants) { v in
                                Button(v.title) { selectedVariant = v; Task { await model.perform("view", body: ["frameId": v.id]) } }.buttonStyle(.bordered)
                            }
                        }
                        if let v = selectedVariant {
                            picture { remoteImage(ref.imageURL); remoteImage(v.imageURL).opacity(0.65) }.frame(maxWidth: 420)
                            HStack {
                                Button("グループに提案") { Task { await model.perform("proposals", body: ["frameId": v.id]) } }
                                if model.isRepresentative { Button("撮影フレームに確定") { Task { await model.activate(v.id); if model.error.isEmpty { showLibrary = false } } } }
                            }.buttonStyle(.borderedProminent).disabled(model.busy)
                        }
                    }
                    if model.isRepresentative, let session = model.session {
                        Menu("代表者を変更") {
                            ForEach(Array(session.subjects.enumerated()), id: \.element.id) { index, subject in
                                Button("\(index + 1)人目") { Task { await model.perform("representative", body: ["subjectId": subject.id, "expectedVersion": session.version]) } }
                            }
                        }
                    }
                    if !model.error.isEmpty { Text(model.error).foregroundStyle(.red) }
                }.padding()
            }.navigationTitle("フレームライブラリ").toolbar { Button("閉じる") { showLibrary = false } }.task { await model.loadLibrary() }
        }
    }
    private var photosView: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 240))]) {
                    ForEach(model.session?.photos ?? []) { photo in
                        VStack { remoteImage(photo.imageURL, authenticated: true).aspectRatio(4 / 3, contentMode: .fit); Text(photo.decision == "saved" ? "保存済み" : "撮影者が保存・削除を選択中") }
                    }
                }.padding()
            }.navigationTitle("撮影写真").toolbar { Button("閉じる") { showPhotos = false } }
        }
    }
}

final class WISSAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        .landscape
    }
}
