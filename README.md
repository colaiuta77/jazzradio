# Jazz Radio

BookOasis에서 책을 읽으며 인터넷 재즈 라디오를 들을 수 있는 사이드바 플러그인입니다.

**버전 · v1.5.9**

![Jazz Radio 화면](docs/screenshot.png?v=1.5.9)

## 주요 기능

- RelaxingJazz, Radio Swiss Jazz, Jazz24의 3개 방송국.
- 재생·일시정지, 볼륨 조절, 현재 곡과 앨범 표지 표시.
- 다른 메뉴로 이동해도 재생을 유지하는 미니 플레이어. 위치 이동과 모바일 접기 지원.
- 7가지 시각화. Live Spectrum, Mirror Bars, Line Spectrum, Waveform, Vintage Amp, Amber Ribbon, Jazz Constellation.
- 빈티지 앰프의 좌우 VU 바늘과 재생 상태에 따른 LED·전원 스위치.
- 마지막 방송국, 볼륨, 시각화 모드, 미니 플레이어 위치 저장.

시각화 영역을 누르면 모드가 바뀝니다. 앰프의 전원 스위치는 재생·일시정지로 동작합니다. 메뉴 이동 후 재생은 같은 페이지 안에서 유지되며, 새로고침 후 자동 재생하지 않습니다.

## 설치

이 저장소의 실행 파일을 BookOasis의 `plugins/metadata/jazzradio/`에 배치합니다.

```text
plugins/metadata/jazzradio/
├── __init__.py
├── jazzradio.py
├── index.html
├── style.css
├── script.js
└── VERSION
```

BookOasis에서 플러그인을 로드·활성화한 후 사이드바의 **Jazz Radio**를 선택합니다. 기존 설치를 교체했다면 BookOasis에 변경 소스를 다시 로드하고 브라우저를 새로고침하세요. 현재 플러그인 자체의 자동 업데이트 주소는 설정되어 있지 않습니다.

## iOS Safari 제약사항

- 사용자 확인 결과, iOS에서는 세 방송국 모두 소리는 재생되지만 음악에 반응하는 시각화 분석 신호를 받지 못하는 문제가 남아 있습니다. **v1.5.9에서도 해결되지 않았습니다.**
- 분석 신호가 없으면 일반 시각화는 기본 애니메이션으로 표시되고, 빈티지 앰프의 VU 바늘은 실제 음량에 반응하지 않습니다. 안내는 화면 맨 아래에 표시됩니다.
- iOS의 볼륨은 기기 볼륨 버튼으로 조절합니다.
- Safari의 스트림 오디오 분석과 관련한 [WebKit 보고](https://bugs.webkit.org/show_bug.cgi?id=180696)가 있습니다. 이 보고만으로 모든 iOS 환경의 원인을 확정한 것은 아닙니다.

방송 스트림은 브라우저에서 직접 재생합니다. 곡 정보는 방송국 ICY 메타데이터, 앨범 표지는 iTunes 검색 결과를 이용하므로 외부 서비스 상태에 따라 누락되거나 정확하지 않을 수 있습니다.

[변경 내역](CHANGELOG.md)
