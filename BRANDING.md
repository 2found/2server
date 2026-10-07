# 2server — Branding & Naming

Tài liệu này áp dụng hệ branding của **2found** cho 2server: tên sản phẩm,
repository, command, README, docs và nội dung giới thiệu.

## Identity

| Thành phần | Tên chuẩn |
| --- | --- |
| Brand | `2found` |
| Product / repository | `2server` |
| Category | Infrastructure and deployment |
| GitHub | [2found/2server](https://github.com/2found/2server) |
| CLI | `2srv` |
| CLI compatibility alias | `2server` |
| npm package hiện tại | `@2server/cli` |
| Endorsement | A 2found product. |

Viết `2found` và `2server` liền, chữ thường. Không dùng `2Server`,
`2found 2server`, `2server Platform` hoặc thêm persona cho CLI.

2server thuộc nhóm **Tools for building companies** của 2found. Nó phụ trách
provision, deploy, environment management, release, rollback và infrastructure
automation. Các công cụ khác trong ecosystem có thể kết nối qua boundary rõ
ràng; branding không tạo dependency bắt buộc.

## Positioning and copy

Mô tả ngắn:

> Deploy and operate apps on infrastructure you own.

Mô tả đầy đủ:

> 2server is a 2found tool for infrastructure and deployment. Define apps in
> your repository, deploy over SSH, and keep secrets and applied state on your VM.

Lockup khi cần giới thiệu ownership:

```text
2server
Infrastructure and deployment.
A 2found product.
github.com/2found/2server
```

Các câu mô tả là supporting copy, không phải tagline mới. Tagline của 2found
là **From idea to company.**

Nói về outcome trước architecture. Dùng câu ngắn, rõ, thực tế, bình tĩnh và
technical. Nêu rõ workflow đã hỗ trợ; proposal trong roadmap không phải tính
năng đã phát hành. Không dùng “all-in-one”, “AI founder”, “autonomous company”
hoặc hứa thay thế người vận hành. Không gọi project là open source khi package
còn khai báo `UNLICENSED`.

## Commands and compatibility

Ưu tiên `2srv` trong hướng dẫn, help và ví dụ mới:

```sh
npm install -g @2server/cli
2srv help
2srv deploy -f api/2server/deploy.yaml --apply
```

`2server` là alias tương thích, chạy cùng entry point. Alias `2srv` có trong
checkout này; khi dùng bản npm cũ, cần nâng cấp đến bản có alias hoặc tiếp tục
dùng `2server`. Tên package npm không tự đổi theo GitHub organization.

Branding không đổi các technical contract đang có:

- `apiVersion: 2server.app/v1` là schema identifier, không phải public domain.
- `.2server/`, `/opt/2server/`, `~/.local/state/2server/`, thư mục manifest
  `app/2server/` và đường dẫn `bin/2server.cjs` giữ nguyên.
- `io.2server.*`, `x-2server`, tên container, ownership labels, backup prefixes,
  Terraform resource names và biến môi trường giữ nguyên.
- Skill vẫn tên `2server`, đặt ở `skills/2server/` và gọi bằng `$2server`.

Không thay tên trong bằng chứng lịch sử hoặc đổi identity của tài nguyên đang
chạy để làm cho branding đồng nhất.

## Links and domains

Repository chuẩn là [github.com/2found/2server](https://github.com/2found/2server).
Ecosystem domain là [2found.io](https://2found.io).
Không dùng `2server.app` như địa chỉ website hoặc tên brand. Schema identifier
ở trên vẫn hợp lệ. Không tự tạo domain, docs site hoặc integration chưa có.

Giữ link nội bộ tương đối để docs dùng được trong checkout độc lập và npm
artifact. Deployment targets, credentials và bằng chứng vận hành của từng
khách hàng thuộc consuming repository, không thuộc tài liệu sản phẩm chung.

## Websites and design system

Mọi website của 2server, gồm landing page, docs site và các web surface khác,
đều dùng **2ui**: shared React component library và design tokens của 2found.

| Thành phần | Tên chuẩn |
| --- | --- |
| Library | `2ui` |
| Repository | `2found/2ui` (private) |
| npm package | `@tofound/ui` |

`tofound` là npm distribution namespace; brand vẫn là **2found**. Tái sử dụng
component có sẵn trước khi tạo mới. Dùng design tokens cho màu, font, radius
và motion; không hardcode hoặc tạo một design system song song. 2server sở hữu
theme và visual identity của mình, theo hướng minimal, structured, technical,
quiet và precise. Không cần mascot.

Checkout hiện tại là CLI, không có website. Quy tắc này áp dụng khi xây hoặc
chỉnh website; nó không yêu cầu thêm frontend dependency vào package CLI.
