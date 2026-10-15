
.cache/issue936/before-host:	file format mach-o arm64

Disassembly of section __TEXT,__text:

000000010004052c <_value.scalar>:
10004052c: a9bd57f6    	stp	x22, x21, [sp, #-0x30]!
100040530: a9014ff4    	stp	x20, x19, [sp, #0x10]
100040534: a9027bfd    	stp	x29, x30, [sp, #0x20]
100040538: 910083fd    	add	x29, sp, #0x20
10004053c: aa0203f4    	mov	x20, x2
100040540: aa0103f5    	mov	x21, x1
100040544: aa0003f3    	mov	x19, x0
100040548: a9402020    	ldp	x0, x8, [x1]
10004054c: b9412049    	ldr	w9, [x2, #0x120]
100040550: 71001d3f    	cmp	w9, #0x7
100040554: 5400020c    	b.gt	0x100040594 <_value.scalar+0x68>
100040558: 7100193f    	cmp	w9, #0x6
10004055c: 54000360    	b.eq	0x1000405c8 <_value.scalar+0x9c>
100040560: 71001d3f    	cmp	w9, #0x7
100040564: 540002a1    	b.ne	0x1000405b8 <_value.scalar+0x8c>
100040568: f940068a    	ldr	x10, [x20, #0x8]
10004056c: b40009ca    	cbz	x10, 0x1000406a4 <_value.scalar+0x178>
100040570: d2800009    	mov	x9, #0x0                ; =0
100040574: f940028b    	ldr	x11, [x20]
100040578: 9100416b    	add	x11, x11, #0x10
10004057c: f841856c    	ldr	x12, [x11], #0x18
100040580: f940ad8c    	ldr	x12, [x12, #0x158]
100040584: 9acc6529    	umax	x9, x9, x12
100040588: f100054a    	subs	x10, x10, #0x1
10004058c: 54ffff81    	b.ne	0x10004057c <_value.scalar+0x50>
100040590: 14000017    	b	0x1000405ec <_value.scalar+0xc0>
100040594: 7100213f    	cmp	w9, #0x8
100040598: 54000780    	b.eq	0x100040688 <_value.scalar+0x15c>
10004059c: 7100313f    	cmp	w9, #0xc
1000405a0: 540000c1    	b.ne	0x1000405b8 <_value.scalar+0x8c>
1000405a4: f9401689    	ldr	x9, [x20, #0x28]
1000405a8: f940ad29    	ldr	x9, [x9, #0x158]
1000405ac: b1000536    	adds	x22, x9, #0x1
1000405b0: 54000882    	b.hs	0x1000406c0 <_value.scalar+0x194>
1000405b4: 14000010    	b	0x1000405f4 <_value.scalar+0xc8>
1000405b8: 7100393f    	cmp	w9, #0xe
1000405bc: 54000902    	b.hs	0x1000406dc <_value.scalar+0x1b0>
1000405c0: d2800016    	mov	x22, #0x0               ; =0
1000405c4: 1400000c    	b	0x1000405f4 <_value.scalar+0xc8>
1000405c8: f940068a    	ldr	x10, [x20, #0x8]
1000405cc: b400074a    	cbz	x10, 0x1000406b4 <_value.scalar+0x188>
1000405d0: d2800009    	mov	x9, #0x0                ; =0
1000405d4: f940028b    	ldr	x11, [x20]
1000405d8: f840856c    	ldr	x12, [x11], #0x8
1000405dc: f940ad8c    	ldr	x12, [x12, #0x158]
1000405e0: 9acc6529    	umax	x9, x9, x12
1000405e4: f100054a    	subs	x10, x10, #0x1
1000405e8: 54ffff81    	b.ne	0x1000405d8 <_value.scalar+0xac>
1000405ec: b1000536    	adds	x22, x9, #0x1
1000405f0: 54000682    	b.hs	0x1000406c0 <_value.scalar+0x194>
1000405f4: dac143fe    	xpaci	x30
1000405f8: f9400108    	ldr	x8, [x8]
1000405fc: 52802e01    	mov	w1, #0x170              ; =368
100040600: 52800082    	mov	w2, #0x4                ; =4
100040604: aa1e03e3    	mov	x3, x30
100040608: d63f0100    	blr	x8
10004060c: b40005a0    	cbz	x0, 0x1000406c0 <_value.scalar+0x194>
100040610: 4f05e540    	movi.16b	v0, #0xaa
100040614: ad0a8000    	stp	q0, q0, [x0, #0x150]
100040618: ad098000    	stp	q0, q0, [x0, #0x130]
10004061c: ad088000    	stp	q0, q0, [x0, #0x110]
100040620: ad078000    	stp	q0, q0, [x0, #0xf0]
100040624: ad068000    	stp	q0, q0, [x0, #0xd0]
100040628: ad058000    	stp	q0, q0, [x0, #0xb0]
10004062c: ad048000    	stp	q0, q0, [x0, #0x90]
100040630: ad038000    	stp	q0, q0, [x0, #0x70]
100040634: ad028000    	stp	q0, q0, [x0, #0x50]
100040638: ad018000    	stp	q0, q0, [x0, #0x30]
10004063c: ad008000    	stp	q0, q0, [x0, #0x10]
100040640: 3d800000    	str	q0, [x0]
100040644: f2400c1f    	tst	x0, #0xf
100040648: 54000481    	b.ne	0x1000406d8 <_value.scalar+0x1ac>
10004064c: 9104e008    	add	x8, x0, #0x138
100040650: 3dc002a0    	ldr	q0, [x21]
100040654: 3d800100    	str	q0, [x8]
100040658: aa0003f5    	mov	x21, x0
10004065c: aa1403e1    	mov	x1, x20
100040660: 52802602    	mov	w2, #0x130              ; =304
100040664: 9406f728    	bl	0x1001fe304 <_writev+0x1001fe304>
100040668: 52800008    	mov	w8, #0x0                ; =0
10004066c: 52800029    	mov	w9, #0x1                ; =1
100040670: f9009aa9    	str	x9, [x21, #0x130]
100040674: 7902d2bf    	strh	wzr, [x21, #0x168]
100040678: a915feb6    	stp	x22, xzr, [x21, #0x158]
10004067c: a914febf    	stp	xzr, xzr, [x21, #0x148]
100040680: f9000275    	str	x21, [x19]
100040684: 14000010    	b	0x1000406c4 <_value.scalar+0x198>
100040688: a9402a89    	ldp	x9, x10, [x20]
10004068c: f940ad29    	ldr	x9, [x9, #0x158]
100040690: f940ad4a    	ldr	x10, [x10, #0x158]
100040694: 9aca6529    	umax	x9, x9, x10
100040698: b1000536    	adds	x22, x9, #0x1
10004069c: 54000122    	b.hs	0x1000406c0 <_value.scalar+0x194>
1000406a0: 17ffffd5    	b	0x1000405f4 <_value.scalar+0xc8>
1000406a4: d2800009    	mov	x9, #0x0                ; =0
1000406a8: b1000536    	adds	x22, x9, #0x1
1000406ac: 54fffa43    	b.lo	0x1000405f4 <_value.scalar+0xc8>
1000406b0: 14000004    	b	0x1000406c0 <_value.scalar+0x194>
1000406b4: d2800009    	mov	x9, #0x0                ; =0
1000406b8: b1000536    	adds	x22, x9, #0x1
1000406bc: 54fff9c3    	b.lo	0x1000405f4 <_value.scalar+0xc8>
1000406c0: 528000a8    	mov	w8, #0x5                ; =5
1000406c4: 79001268    	strh	w8, [x19, #0x8]
1000406c8: a9427bfd    	ldp	x29, x30, [sp, #0x20]
1000406cc: a9414ff4    	ldp	x20, x19, [sp, #0x10]
1000406d0: a8c357f6    	ldp	x22, x21, [sp], #0x30
1000406d4: d65f03c0    	ret
1000406d8: 9406bc22    	bl	0x1001ef760 <_debug.FullPanic((function 'defaultPanic')).incorrectAlignment>
1000406dc: 9406bb16    	bl	0x1001ef334 <_debug.FullPanic((function 'defaultPanic')).corruptSwitch>

0000000100049cb8 <_units.Unit.compatible>:
100049cb8: d104c3ff    	sub	sp, sp, #0x130
100049cbc: a9116ffc    	stp	x28, x27, [sp, #0x110]
100049cc0: a9127bfd    	stp	x29, x30, [sp, #0x120]
100049cc4: 910483fd    	add	x29, sp, #0x120
100049cc8: 90001308    	adrp	x8, 0x1002a9000 <___anon_137340+0x38>
100049ccc: f9470908    	ldr	x8, [x8, #0xe10]
100049cd0: f9400108    	ldr	x8, [x8]
100049cd4: f81e83a8    	stur	x8, [x29, #-0x18]
100049cd8: b9801808    	ldrsw	x8, [x0, #0x18]
100049cdc: b9802809    	ldrsw	x9, [x0, #0x28]
100049ce0: 8b090529    	add	x9, x9, x9, lsl #1
100049ce4: 8b080128    	add	x8, x9, x8
100049ce8: b9800809    	ldrsw	x9, [x0, #0x8]
100049cec: a900a3e9    	stp	x9, x8, [sp, #0x8]
100049cf0: b9804809    	ldrsw	x9, [x0, #0x48]
100049cf4: b9805808    	ldrsw	x8, [x0, #0x58]
100049cf8: a902a3e9    	stp	x9, x8, [sp, #0x28]
100049cfc: b9806809    	ldrsw	x9, [x0, #0x68]
100049d00: b9807808    	ldrsw	x8, [x0, #0x78]
100049d04: a903a3e9    	stp	x9, x8, [sp, #0x38]
100049d08: b9808809    	ldrsw	x9, [x0, #0x88]
100049d0c: b9809808    	ldrsw	x8, [x0, #0x98]
100049d10: a904a3e9    	stp	x9, x8, [sp, #0x48]
100049d14: b980a809    	ldrsw	x9, [x0, #0xa8]
100049d18: b980b808    	ldrsw	x8, [x0, #0xb8]
100049d1c: a905a3e9    	stp	x9, x8, [sp, #0x58]
100049d20: b980c809    	ldrsw	x9, [x0, #0xc8]
100049d24: b980d808    	ldrsw	x8, [x0, #0xd8]
100049d28: a906a3e9    	stp	x9, x8, [sp, #0x68]
100049d2c: b9803809    	ldrsw	x9, [x0, #0x38]
100049d30: a901a7ff    	stp	xzr, x9, [sp, #0x18]
100049d34: b980e808    	ldrsw	x8, [x0, #0xe8]
100049d38: b980f809    	ldrsw	x9, [x0, #0xf8]
100049d3c: a907a7e8    	stp	x8, x9, [sp, #0x78]
100049d40: b9801828    	ldrsw	x8, [x1, #0x18]
100049d44: b9802829    	ldrsw	x9, [x1, #0x28]
100049d48: 8b090529    	add	x9, x9, x9, lsl #1
100049d4c: 8b080128    	add	x8, x9, x8
100049d50: b9800829    	ldrsw	x9, [x1, #0x8]
100049d54: a908a3e9    	stp	x9, x8, [sp, #0x88]
100049d58: b9803829    	ldrsw	x9, [x1, #0x38]
100049d5c: b9804828    	ldrsw	x8, [x1, #0x48]
100049d60: a909a7ff    	stp	xzr, x9, [sp, #0x98]
100049d64: b9805829    	ldrsw	x9, [x1, #0x58]
100049d68: a90aa7e8    	stp	x8, x9, [sp, #0xa8]
100049d6c: b9806828    	ldrsw	x8, [x1, #0x68]
100049d70: b9807829    	ldrsw	x9, [x1, #0x78]
100049d74: a90ba7e8    	stp	x8, x9, [sp, #0xb8]
100049d78: b9808828    	ldrsw	x8, [x1, #0x88]
100049d7c: b9809829    	ldrsw	x9, [x1, #0x98]
100049d80: a90ca7e8    	stp	x8, x9, [sp, #0xc8]
100049d84: b980a828    	ldrsw	x8, [x1, #0xa8]
100049d88: b980b829    	ldrsw	x9, [x1, #0xb8]
100049d8c: a90da7e8    	stp	x8, x9, [sp, #0xd8]
100049d90: b980c828    	ldrsw	x8, [x1, #0xc8]
100049d94: b980d829    	ldrsw	x9, [x1, #0xd8]
100049d98: a90ea7e8    	stp	x8, x9, [sp, #0xe8]
100049d9c: b980e828    	ldrsw	x8, [x1, #0xe8]
100049da0: b980f82a    	ldrsw	x10, [x1, #0xf8]
100049da4: a90fabe8    	stp	x8, x10, [sp, #0xf8]
100049da8: 910023e0    	add	x0, sp, #0x8
100049dac: 910223e2    	add	x2, sp, #0x88
100049db0: 52801001    	mov	w1, #0x80               ; =128
100049db4: 52801003    	mov	w3, #0x80               ; =128
100049db8: 97ffc47f    	bl	0x10003afb4 <_mem.eqlBytes>
100049dbc: f85e83a8    	ldur	x8, [x29, #-0x18]
100049dc0: 90001309    	adrp	x9, 0x1002a9000 <___anon_137340+0x38>
100049dc4: f9470929    	ldr	x9, [x9, #0xe10]
100049dc8: f9400129    	ldr	x9, [x9]
100049dcc: eb08013f    	cmp	x9, x8
100049dd0: 540000c1    	b.ne	0x100049de8 <_units.Unit.compatible+0x130>
100049dd4: 12000000    	and	w0, w0, #0x1
100049dd8: a9527bfd    	ldp	x29, x30, [sp, #0x120]
100049ddc: a9516ffc    	ldp	x28, x27, [sp, #0x110]
100049de0: 9104c3ff    	add	sp, sp, #0x130
100049de4: d65f03c0    	ret
100049de8: 9406d0a2    	bl	0x1001fe070 <_writev+0x1001fe070>

00000001000a9e68 <_machine.convert.convert>:
1000a9e68: a9ba6ffc    	stp	x28, x27, [sp, #-0x60]!
1000a9e6c: a90167fa    	stp	x26, x25, [sp, #0x10]
1000a9e70: a9025ff8    	stp	x24, x23, [sp, #0x20]
1000a9e74: a90357f6    	stp	x22, x21, [sp, #0x30]
1000a9e78: a9044ff4    	stp	x20, x19, [sp, #0x40]
1000a9e7c: a9057bfd    	stp	x29, x30, [sp, #0x50]
1000a9e80: 910143fd    	add	x29, sp, #0x50
1000a9e84: d133c3ff    	sub	sp, sp, #0xcf0
1000a9e88: aa1e03f6    	mov	x22, x30
1000a9e8c: aa0503f8    	mov	x24, x5
1000a9e90: aa0403f9    	mov	x25, x4
1000a9e94: aa0303f7    	mov	x23, x3
1000a9e98: aa0203f4    	mov	x20, x2
1000a9e9c: aa0103f5    	mov	x21, x1
1000a9ea0: aa0003f3    	mov	x19, x0
1000a9ea4: 911803fb    	add	x27, sp, #0x600
1000a9ea8: 90001008    	adrp	x8, 0x1002a9000 <___anon_137340+0x38>
1000a9eac: f9470908    	ldr	x8, [x8, #0xe10]
1000a9eb0: f9400108    	ldr	x8, [x8]
1000a9eb4: f81983a8    	stur	x8, [x29, #-0x68]
1000a9eb8: f10000bf    	cmp	x5, #0x0
1000a9ebc: 9a9f149a    	csinc	x26, x4, xzr, ne
1000a9ec0: b0000d22    	adrp	x2, 0x10024e000 <___anon_92453+0x3f>
1000a9ec4: 91101c42    	add	x2, x2, #0x407
1000a9ec8: aa1a03e0    	mov	x0, x26
1000a9ecc: aa0503e1    	mov	x1, x5
1000a9ed0: 52800083    	mov	w3, #0x4                ; =4
1000a9ed4: 97fe4438    	bl	0x10003afb4 <_mem.eqlBytes>
1000a9ed8: 360004c0    	tbz	w0, #0x0, 0x1000a9f70 <_machine.convert.convert+0x108>
1000a9edc: b94122e8    	ldr	w8, [x23, #0x120]
1000a9ee0: 7100151f    	cmp	w8, #0x5
1000a9ee4: 54000881    	b.ne	0x1000a9ff4 <_machine.convert.convert+0x18c>
1000a9ee8: a9405ef8    	ldp	x24, x23, [x23]
1000a9eec: aa1803e0    	mov	x0, x24
1000a9ef0: aa1703e1    	mov	x1, x23
1000a9ef4: 97fedca0    	bl	0x100061174 <_unicode.utf8.validate>
1000a9ef8: 36001720    	tbz	w0, #0x0, 0x1000aa1dc <_machine.convert.convert+0x374>
1000a9efc: a9406695    	ldp	x21, x25, [x20]
1000a9f00: aa1803e0    	mov	x0, x24
1000a9f04: aa1703e1    	mov	x1, x23
1000a9f08: 97fedc9b    	bl	0x100061174 <_unicode.utf8.validate>
1000a9f0c: 36000fc0    	tbz	w0, #0x0, 0x1000aa104 <_machine.convert.convert+0x29c>
1000a9f10: 912de3e0    	add	x0, sp, #0xb78
1000a9f14: aa1403e1    	mov	x1, x20
1000a9f18: aa1803e2    	mov	x2, x24
1000a9f1c: aa1703e3    	mov	x3, x23
1000a9f20: 97fec3f2    	bl	0x10005aee8 <_unicode.normalize.nfc>
1000a9f24: 795713fa    	ldrh	w26, [sp, #0xb88]
1000a9f28: 35000c3a    	cbnz	w26, 0x1000aa0ac <_machine.convert.convert+0x244>
1000a9f2c: f942bf78    	ldr	x24, [x27, #0x578]
1000a9f30: f942c377    	ldr	x23, [x27, #0x580]
1000a9f34: f902d378    	str	x24, [x27, #0x5a0]
1000a9f38: f902d777    	str	x23, [x27, #0x5a8]
1000a9f3c: 52800088    	mov	w8, #0x4                ; =4
1000a9f40: b90cc3e8    	str	w8, [sp, #0xcc0]
1000a9f44: 912e43e0    	add	x0, sp, #0xb90
1000a9f48: 912e83e2    	add	x2, sp, #0xba0
1000a9f4c: aa1403e1    	mov	x1, x20
1000a9f50: 97fe5977    	bl	0x10004052c <_value.scalar>
1000a9f54: 795733fa    	ldrh	w26, [sp, #0xb98]
1000a9f58: 3500091a    	cbnz	w26, 0x1000aa078 <_machine.convert.convert+0x210>
1000a9f5c: f942cb68    	ldr	x8, [x27, #0x590]
1000a9f60: 790063ff    	strh	wzr, [sp, #0x30]
1000a9f64: f90017e8    	str	x8, [sp, #0x28]
1000a9f68: 9100a3e8    	add	x8, sp, #0x28
1000a9f6c: 1400009e    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000a9f70: 910283fc    	add	x28, sp, #0xa0
1000a9f74: b0000d22    	adrp	x2, 0x10024e000 <___anon_92453+0x3f>
1000a9f78: 9113ac42    	add	x2, x2, #0x4eb
1000a9f7c: aa1a03e0    	mov	x0, x26
1000a9f80: aa1803e1    	mov	x1, x24
1000a9f84: 528000c3    	mov	w3, #0x6                ; =6
1000a9f88: 97fe440b    	bl	0x10003afb4 <_mem.eqlBytes>
1000a9f8c: 36000940    	tbz	w0, #0x0, 0x1000aa0b4 <_machine.convert.convert+0x24c>
1000a9f90: b94122e8    	ldr	w8, [x23, #0x120]
1000a9f94: 7100091f    	cmp	w8, #0x2
1000a9f98: 54000e40    	b.eq	0x1000aa160 <_machine.convert.convert+0x2f8>
1000a9f9c: 7100111f    	cmp	w8, #0x4
1000a9fa0: 540011a1    	b.ne	0x1000aa1d4 <_machine.convert.convert+0x36c>
1000a9fa4: a9400ae1    	ldp	x1, x2, [x23]
1000a9fa8: 9101c3e0    	add	x0, sp, #0x70
1000a9fac: 97fea977    	bl	0x100054588 <_decimal.decimal.Decimal.parse>
1000a9fb0: 794123e8    	ldrh	w8, [sp, #0x90]
1000a9fb4: 35001148    	cbnz	w8, 0x1000aa1dc <_machine.convert.convert+0x374>
1000a9fb8: ad4387e0    	ldp	q0, q1, [sp, #0x70]
1000a9fbc: ad000780    	stp	q0, q1, [x28]
1000a9fc0: 52800048    	mov	w8, #0x2                ; =2
1000a9fc4: b901c3e8    	str	w8, [sp, #0x1c0]
1000a9fc8: 910743e0    	add	x0, sp, #0x1d0
1000a9fcc: 910283e2    	add	x2, sp, #0xa0
1000a9fd0: aa1403e1    	mov	x1, x20
1000a9fd4: 97fe5956    	bl	0x10004052c <_value.scalar>
1000a9fd8: 7943b3e8    	ldrh	w8, [sp, #0x1d8]
1000a9fdc: 35003708    	cbnz	w8, 0x1000aa6bc <_machine.convert.convert+0x854>
1000a9fe0: f9409b88    	ldr	x8, [x28, #0x130]
1000a9fe4: 7903d3ff    	strh	wzr, [sp, #0x1e8]
1000a9fe8: f900a388    	str	x8, [x28, #0x140]
1000a9fec: 910783e8    	add	x8, sp, #0x1e0
1000a9ff0: 1400007d    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000a9ff4: 7100391f    	cmp	w8, #0xe
1000a9ff8: 54002582    	b.hs	0x1000aa4a8 <_machine.convert.convert+0x640>
1000a9ffc: 9100e3e0    	add	x0, sp, #0x38
1000aa000: aa1503e1    	mov	x1, x21
1000aa004: aa1703e2    	mov	x2, x23
1000aa008: 94015623    	bl	0x1000ff894 <_machine.chunks.textForm>
1000aa00c: 794093e8    	ldrh	w8, [sp, #0x48]
1000aa010: 35003568    	cbnz	w8, 0x1000aa6bc <_machine.convert.convert+0x854>
1000aa014: a943e3f7    	ldp	x23, x24, [sp, #0x38]
1000aa018: a9406695    	ldp	x21, x25, [x20]
1000aa01c: aa1703e0    	mov	x0, x23
1000aa020: aa1803e1    	mov	x1, x24
1000aa024: 97fedc54    	bl	0x100061174 <_unicode.utf8.validate>
1000aa028: 360006e0    	tbz	w0, #0x0, 0x1000aa104 <_machine.convert.convert+0x29c>
1000aa02c: 912de3e0    	add	x0, sp, #0xb78
1000aa030: aa1403e1    	mov	x1, x20
1000aa034: aa1703e2    	mov	x2, x23
1000aa038: aa1803e3    	mov	x3, x24
1000aa03c: 97fec3ab    	bl	0x10005aee8 <_unicode.normalize.nfc>
1000aa040: 795713fa    	ldrh	w26, [sp, #0xb88]
1000aa044: 3500035a    	cbnz	w26, 0x1000aa0ac <_machine.convert.convert+0x244>
1000aa048: f942bf78    	ldr	x24, [x27, #0x578]
1000aa04c: f942c377    	ldr	x23, [x27, #0x580]
1000aa050: f902d378    	str	x24, [x27, #0x5a0]
1000aa054: f902d777    	str	x23, [x27, #0x5a8]
1000aa058: 52800088    	mov	w8, #0x4                ; =4
1000aa05c: b90cc3e8    	str	w8, [sp, #0xcc0]
1000aa060: 912e43e0    	add	x0, sp, #0xb90
1000aa064: 912e83e2    	add	x2, sp, #0xba0
1000aa068: aa1403e1    	mov	x1, x20
1000aa06c: 97fe5930    	bl	0x10004052c <_value.scalar>
1000aa070: 795733fa    	ldrh	w26, [sp, #0xb98]
1000aa074: 34000d9a    	cbz	w26, 0x1000aa224 <_machine.convert.convert+0x3bc>
1000aa078: b40001b7    	cbz	x23, 0x1000aa0ac <_machine.convert.convert+0x244>
1000aa07c: aa1803e0    	mov	x0, x24
1000aa080: 52801541    	mov	w1, #0xaa               ; =170
1000aa084: aa1703e2    	mov	x2, x23
1000aa088: 940550a5    	bl	0x1001fe31c <_writev+0x1001fe31c>
1000aa08c: dac143f6    	xpaci	x22
1000aa090: f9400f28    	ldr	x8, [x25, #0x18]
1000aa094: aa1503e0    	mov	x0, x21
1000aa098: aa1803e1    	mov	x1, x24
1000aa09c: aa1703e2    	mov	x2, x23
1000aa0a0: 52800003    	mov	w3, #0x0                ; =0
1000aa0a4: aa1603e4    	mov	x4, x22
1000aa0a8: d63f0100    	blr	x8
1000aa0ac: 7900127a    	strh	w26, [x19, #0x8]
1000aa0b0: 1400004f    	b	0x1000aa1ec <_machine.convert.convert+0x384>
1000aa0b4: b0000cc2    	adrp	x2, 0x100243000 <___anon_25247+0x18>
1000aa0b8: 91375042    	add	x2, x2, #0xdd4
1000aa0bc: aa1a03e0    	mov	x0, x26
1000aa0c0: aa1803e1    	mov	x1, x24
1000aa0c4: 528000a3    	mov	w3, #0x5                ; =5
1000aa0c8: 97fe43bb    	bl	0x10003afb4 <_mem.eqlBytes>
1000aa0cc: 36000220    	tbz	w0, #0x0, 0x1000aa110 <_machine.convert.convert+0x2a8>
1000aa0d0: b94122e8    	ldr	w8, [x23, #0x120]
1000aa0d4: 7100111f    	cmp	w8, #0x4
1000aa0d8: 54000b00    	b.eq	0x1000aa238 <_machine.convert.convert+0x3d0>
1000aa0dc: 7100151f    	cmp	w8, #0x5
1000aa0e0: 540007a1    	b.ne	0x1000aa1d4 <_machine.convert.convert+0x36c>
1000aa0e4: f9409ae8    	ldr	x8, [x23, #0x130]
1000aa0e8: b1000508    	adds	x8, x8, #0x1
1000aa0ec: 54002ee2    	b.hs	0x1000aa6c8 <_machine.convert.convert+0x860>
1000aa0f0: f9009ae8    	str	x8, [x23, #0x130]
1000aa0f4: 7903f3ff    	strh	wzr, [sp, #0x1f8]
1000aa0f8: 9107c3e8    	add	x8, sp, #0x1f0
1000aa0fc: f900ab97    	str	x23, [x28, #0x150]
1000aa100: 14000039    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa104: 528012ba    	mov	w26, #0x95              ; =149
1000aa108: 7900127a    	strh	w26, [x19, #0x8]
1000aa10c: 14000038    	b	0x1000aa1ec <_machine.convert.convert+0x384>
1000aa110: d0000cc2    	adrp	x2, 0x100244000 <___anon_51802+0x7>
1000aa114: 910e9c42    	add	x2, x2, #0x3a7
1000aa118: aa1a03e0    	mov	x0, x26
1000aa11c: aa1803e1    	mov	x1, x24
1000aa120: 52800143    	mov	w3, #0xa                ; =10
1000aa124: 97fe43a4    	bl	0x10003afb4 <_mem.eqlBytes>
1000aa128: 360002c0    	tbz	w0, #0x0, 0x1000aa180 <_machine.convert.convert+0x318>
1000aa12c: b94122e8    	ldr	w8, [x23, #0x120]
1000aa130: 7100111f    	cmp	w8, #0x4
1000aa134: 54000b20    	b.eq	0x1000aa298 <_machine.convert.convert+0x430>
1000aa138: 7100291f    	cmp	w8, #0xa
1000aa13c: 540004c1    	b.ne	0x1000aa1d4 <_machine.convert.convert+0x36c>
1000aa140: f9409ae8    	ldr	x8, [x23, #0x130]
1000aa144: b1000508    	adds	x8, x8, #0x1
1000aa148: 54002c02    	b.hs	0x1000aa6c8 <_machine.convert.convert+0x860>
1000aa14c: f9009ae8    	str	x8, [x23, #0x130]
1000aa150: 790433ff    	strh	wzr, [sp, #0x218]
1000aa154: 910843e8    	add	x8, sp, #0x210
1000aa158: f900bb97    	str	x23, [x28, #0x170]
1000aa15c: 14000022    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa160: f9409ae8    	ldr	x8, [x23, #0x130]
1000aa164: b1000508    	adds	x8, x8, #0x1
1000aa168: 54002b02    	b.hs	0x1000aa6c8 <_machine.convert.convert+0x860>
1000aa16c: f9009ae8    	str	x8, [x23, #0x130]
1000aa170: 7900d3ff    	strh	wzr, [sp, #0x68]
1000aa174: 910183e8    	add	x8, sp, #0x60
1000aa178: f90033f7    	str	x23, [sp, #0x60]
1000aa17c: 1400001a    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa180: 910e23f6    	add	x22, sp, #0x388
1000aa184: b0000cc2    	adrp	x2, 0x100243000 <___anon_25247+0x18>
1000aa188: 91378042    	add	x2, x2, #0xde0
1000aa18c: aa1a03e0    	mov	x0, x26
1000aa190: aa1803e1    	mov	x1, x24
1000aa194: 528000e3    	mov	w3, #0x7                ; =7
1000aa198: 97fe4387    	bl	0x10003afb4 <_mem.eqlBytes>
1000aa19c: 360006e0    	tbz	w0, #0x0, 0x1000aa278 <_machine.convert.convert+0x410>
1000aa1a0: b94122e8    	ldr	w8, [x23, #0x120]
1000aa1a4: 7100111f    	cmp	w8, #0x4
1000aa1a8: 540013e0    	b.eq	0x1000aa424 <_machine.convert.convert+0x5bc>
1000aa1ac: 7100251f    	cmp	w8, #0x9
1000aa1b0: 54000121    	b.ne	0x1000aa1d4 <_machine.convert.convert+0x36c>
1000aa1b4: f9409ae8    	ldr	x8, [x23, #0x130]
1000aa1b8: b1000508    	adds	x8, x8, #0x1
1000aa1bc: 54002862    	b.hs	0x1000aa6c8 <_machine.convert.convert+0x860>
1000aa1c0: f9009ae8    	str	x8, [x23, #0x130]
1000aa1c4: 790703ff    	strh	wzr, [sp, #0x380]
1000aa1c8: 910de3e8    	add	x8, sp, #0x378
1000aa1cc: f9016f97    	str	x23, [x28, #0x2d8]
1000aa1d0: 14000005    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa1d4: 7100391f    	cmp	w8, #0xe
1000aa1d8: 54001682    	b.hs	0x1000aa4a8 <_machine.convert.convert+0x640>
1000aa1dc: 90000b68    	adrp	x8, 0x100216000 <___anon_77842+0x18>
1000aa1e0: 911e6108    	add	x8, x8, #0x798
1000aa1e4: 3dc00100    	ldr	q0, [x8]
1000aa1e8: 3d800260    	str	q0, [x19]
1000aa1ec: f85983a8    	ldur	x8, [x29, #-0x68]
1000aa1f0: f0000fe9    	adrp	x9, 0x1002a9000 <___anon_137340+0x38>
1000aa1f4: f9470929    	ldr	x9, [x9, #0xe10]
1000aa1f8: f9400129    	ldr	x9, [x9]
1000aa1fc: eb08013f    	cmp	x9, x8
1000aa200: 54002621    	b.ne	0x1000aa6c4 <_machine.convert.convert+0x85c>
1000aa204: 9133c3ff    	add	sp, sp, #0xcf0
1000aa208: a9457bfd    	ldp	x29, x30, [sp, #0x50]
1000aa20c: a9444ff4    	ldp	x20, x19, [sp, #0x40]
1000aa210: a94357f6    	ldp	x22, x21, [sp, #0x30]
1000aa214: a9425ff8    	ldp	x24, x23, [sp, #0x20]
1000aa218: a94167fa    	ldp	x26, x25, [sp, #0x10]
1000aa21c: a8c66ffc    	ldp	x28, x27, [sp], #0x60
1000aa220: d65f03c0    	ret
1000aa224: f942cb68    	ldr	x8, [x27, #0x590]
1000aa228: 7900b3ff    	strh	wzr, [sp, #0x58]
1000aa22c: f9002be8    	str	x8, [sp, #0x50]
1000aa230: 910143e8    	add	x8, sp, #0x50
1000aa234: 17ffffec    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa238: a94056f9    	ldp	x25, x21, [x23]
1000aa23c: a9406a97    	ldp	x23, x26, [x20]
1000aa240: b4000675    	cbz	x21, 0x1000aa30c <_machine.convert.convert+0x4a4>
1000aa244: aa1603e3    	mov	x3, x22
1000aa248: dac143e3    	xpaci	x3
1000aa24c: f9400348    	ldr	x8, [x26]
1000aa250: aa1703e0    	mov	x0, x23
1000aa254: aa1503e1    	mov	x1, x21
1000aa258: 52800002    	mov	w2, #0x0                ; =0
1000aa25c: d63f0100    	blr	x8
1000aa260: b40011a0    	cbz	x0, 0x1000aa494 <_machine.convert.convert+0x62c>
1000aa264: aa0003f8    	mov	x24, x0
1000aa268: 52801541    	mov	w1, #0xaa               ; =170
1000aa26c: aa1503e2    	mov	x2, x21
1000aa270: 9405502b    	bl	0x1001fe31c <_writev+0x1001fe31c>
1000aa274: 14000027    	b	0x1000aa310 <_machine.convert.convert+0x4a8>
1000aa278: 9113e3e0    	add	x0, sp, #0x4f8
1000aa27c: aa1903e1    	mov	x1, x25
1000aa280: aa1803e2    	mov	x2, x24
1000aa284: 97fea6ff    	bl	0x100053e80 <_units.Unit.parse>
1000aa288: 794bf3e8    	ldrh	w8, [sp, #0x5f8]
1000aa28c: 34000908    	cbz	w8, 0x1000aa3ac <_machine.convert.convert+0x544>
1000aa290: a9007e7f    	stp	xzr, xzr, [x19]
1000aa294: 17ffffd6    	b	0x1000aa1ec <_machine.convert.convert+0x384>
1000aa298: a94006e0    	ldp	x0, x1, [x23]
1000aa29c: f0000ce2    	adrp	x2, 0x100249000 <___anon_83631+0x2d>
1000aa2a0: 913ea842    	add	x2, x2, #0xfaa
1000aa2a4: 52800083    	mov	w3, #0x4                ; =4
1000aa2a8: 9400a87c    	bl	0x1000d4498 <_mem.trim__func_1557>
1000aa2ac: aa0003e2    	mov	x2, x0
1000aa2b0: aa0103e3    	mov	x3, x1
1000aa2b4: 910013e0    	add	x0, sp, #0x4
1000aa2b8: aa0203e1    	mov	x1, x2
1000aa2bc: aa0303e2    	mov	x2, x3
1000aa2c0: 97fea9e1    	bl	0x100054a44 <_dates.parseCivil>
1000aa2c4: 79404be8    	ldrh	w8, [sp, #0x24]
1000aa2c8: 35fff8a8    	cbnz	w8, 0x1000aa1dc <_machine.convert.convert+0x374>
1000aa2cc: 3cc043e0    	ldur	q0, [sp, #0x4]
1000aa2d0: 3cc143e1    	ldur	q1, [sp, #0x14]
1000aa2d4: ad0c0780    	stp	q0, q1, [x28, #0x180]
1000aa2d8: 52800148    	mov	w8, #0xa                ; =10
1000aa2dc: b90343e8    	str	w8, [sp, #0x340]
1000aa2e0: 910d63e0    	add	x0, sp, #0x358
1000aa2e4: 910883e2    	add	x2, sp, #0x220
1000aa2e8: aa1403e1    	mov	x1, x20
1000aa2ec: 97fe5890    	bl	0x10004052c <_value.scalar>
1000aa2f0: 7946c3e8    	ldrh	w8, [sp, #0x360]
1000aa2f4: 35001e48    	cbnz	w8, 0x1000aa6bc <_machine.convert.convert+0x854>
1000aa2f8: f9415f88    	ldr	x8, [x28, #0x2b8]
1000aa2fc: 7906e3ff    	strh	wzr, [sp, #0x370]
1000aa300: f9016788    	str	x8, [x28, #0x2c8]
1000aa304: 910da3e8    	add	x8, sp, #0x368
1000aa308: 17ffffb7    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa30c: 92800018    	mov	x24, #-0x1              ; =-1
1000aa310: 8b150328    	add	x8, x25, x21
1000aa314: eb08031f    	cmp	x24, x8
1000aa318: 54000082    	b.hs	0x1000aa328 <_machine.convert.convert+0x4c0>
1000aa31c: 8b150308    	add	x8, x24, x21
1000aa320: eb08033f    	cmp	x25, x8
1000aa324: 54001d43    	b.lo	0x1000aa6cc <_machine.convert.convert+0x864>
1000aa328: aa1803e0    	mov	x0, x24
1000aa32c: aa1903e1    	mov	x1, x25
1000aa330: aa1503e2    	mov	x2, x21
1000aa334: 94054ff4    	bl	0x1001fe304 <_writev+0x1001fe304>
1000aa338: f902d378    	str	x24, [x27, #0x5a0]
1000aa33c: f902d775    	str	x21, [x27, #0x5a8]
1000aa340: 528000a8    	mov	w8, #0x5                ; =5
1000aa344: b90cc3e8    	str	w8, [sp, #0xcc0]
1000aa348: 912de3e0    	add	x0, sp, #0xb78
1000aa34c: 912e83e2    	add	x2, sp, #0xba0
1000aa350: aa1403e1    	mov	x1, x20
1000aa354: 97fe5876    	bl	0x10004052c <_value.scalar>
1000aa358: 795703f4    	ldrh	w20, [sp, #0xb80]
1000aa35c: 340001f4    	cbz	w20, 0x1000aa398 <_machine.convert.convert+0x530>
1000aa360: b40009d5    	cbz	x21, 0x1000aa498 <_machine.convert.convert+0x630>
1000aa364: aa1803e0    	mov	x0, x24
1000aa368: 52801541    	mov	w1, #0xaa               ; =170
1000aa36c: aa1503e2    	mov	x2, x21
1000aa370: 94054feb    	bl	0x1001fe31c <_writev+0x1001fe31c>
1000aa374: dac143f6    	xpaci	x22
1000aa378: f9400f48    	ldr	x8, [x26, #0x18]
1000aa37c: aa1703e0    	mov	x0, x23
1000aa380: aa1803e1    	mov	x1, x24
1000aa384: aa1503e2    	mov	x2, x21
1000aa388: 52800003    	mov	w3, #0x0                ; =0
1000aa38c: aa1603e4    	mov	x4, x22
1000aa390: d63f0100    	blr	x8
1000aa394: 14000041    	b	0x1000aa498 <_machine.convert.convert+0x630>
1000aa398: f942bf68    	ldr	x8, [x27, #0x578]
1000aa39c: 790413ff    	strh	wzr, [sp, #0x208]
1000aa3a0: f900b388    	str	x8, [x28, #0x160]
1000aa3a4: 910803e8    	add	x8, sp, #0x200
1000aa3a8: 17ffff8f    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa3ac: a94062fc    	ldp	x28, x24, [x23]
1000aa3b0: 910042e8    	add	x8, x23, #0x10
1000aa3b4: b94122e9    	ldr	w9, [x23, #0x120]
1000aa3b8: 7100093f    	cmp	w9, #0x2
1000aa3bc: 540011a0    	b.eq	0x1000aa5f0 <_machine.convert.convert+0x788>
1000aa3c0: 71000d3f    	cmp	w9, #0x3
1000aa3c4: 54000aa0    	b.eq	0x1000aa518 <_machine.convert.convert+0x6b0>
1000aa3c8: 7100113f    	cmp	w9, #0x4
1000aa3cc: 540006a1    	b.ne	0x1000aa4a0 <_machine.convert.convert+0x638>
1000aa3d0: f0000ce2    	adrp	x2, 0x100249000 <___anon_83631+0x2d>
1000aa3d4: 913ea842    	add	x2, x2, #0xfaa
1000aa3d8: aa1c03e0    	mov	x0, x28
1000aa3dc: aa1803e1    	mov	x1, x24
1000aa3e0: 52800083    	mov	w3, #0x4                ; =4
1000aa3e4: 9400a82d    	bl	0x1000d4498 <_mem.trim__func_1557>
1000aa3e8: aa0003f7    	mov	x23, x0
1000aa3ec: aa0103f9    	mov	x25, x1
1000aa3f0: d280001a    	mov	x26, #0x0               ; =0
1000aa3f4: b4000601    	cbz	x1, 0x1000aa4b4 <_machine.convert.convert+0x64c>
1000aa3f8: 387a6ae8    	ldrb	w8, [x23, x26]
1000aa3fc: 5100c109    	sub	w9, w8, #0x30
1000aa400: 5100b508    	sub	w8, w8, #0x2d
1000aa404: 7100293f    	cmp	w9, #0xa
1000aa408: 7a422900    	ccmp	w8, #0x2, #0x0, hs
1000aa40c: 54000502    	b.hs	0x1000aa4ac <_machine.convert.convert+0x644>
1000aa410: 9100075a    	add	x26, x26, #0x1
1000aa414: eb1a033f    	cmp	x25, x26
1000aa418: 54ffff01    	b.ne	0x1000aa3f8 <_machine.convert.convert+0x590>
1000aa41c: aa1903fa    	mov	x26, x25
1000aa420: 14000025    	b	0x1000aa4b4 <_machine.convert.convert+0x64c>
1000aa424: a94006e0    	ldp	x0, x1, [x23]
1000aa428: f0000ce2    	adrp	x2, 0x100249000 <___anon_83631+0x2d>
1000aa42c: 913ea842    	add	x2, x2, #0xfaa
1000aa430: 52800083    	mov	w3, #0x4                ; =4
1000aa434: 9400a819    	bl	0x1000d4498 <_mem.trim__func_1557>
1000aa438: aa0003e2    	mov	x2, x0
1000aa43c: aa0103e3    	mov	x3, x1
1000aa440: 910e23e0    	add	x0, sp, #0x388
1000aa444: aa0203e1    	mov	x1, x2
1000aa448: aa0303e2    	mov	x2, x3
1000aa44c: 97feaae5    	bl	0x100054fe0 <_dates.parseInstant>
1000aa450: 794733e8    	ldrh	w8, [sp, #0x398]
1000aa454: 35ffec48    	cbnz	w8, 0x1000aa1dc <_machine.convert.convert+0x374>
1000aa458: 3dc002c0    	ldr	q0, [x22]
1000aa45c: 3c8182c0    	stur	q0, [x22, #0x18]
1000aa460: 52800128    	mov	w8, #0x9                ; =9
1000aa464: b904c3e8    	str	w8, [sp, #0x4c0]
1000aa468: 911363e0    	add	x0, sp, #0x4d8
1000aa46c: 910e83e2    	add	x2, sp, #0x3a0
1000aa470: aa1403e1    	mov	x1, x20
1000aa474: 97fe582e    	bl	0x10004052c <_value.scalar>
1000aa478: 7949c3e8    	ldrh	w8, [sp, #0x4e0]
1000aa47c: 35001208    	cbnz	w8, 0x1000aa6bc <_machine.convert.convert+0x854>
1000aa480: f940aac8    	ldr	x8, [x22, #0x150]
1000aa484: 7909e3ff    	strh	wzr, [sp, #0x4f0]
1000aa488: f900b2c8    	str	x8, [x22, #0x160]
1000aa48c: 9113a3e8    	add	x8, sp, #0x4e8
1000aa490: 17ffff55    	b	0x1000aa1e4 <_machine.convert.convert+0x37c>
1000aa494: 528000b4    	mov	w20, #0x5               ; =5
1000aa498: 79001274    	strh	w20, [x19, #0x8]
1000aa49c: 17ffff54    	b	0x1000aa1ec <_machine.convert.convert+0x384>
1000aa4a0: 7100393f    	cmp	w9, #0xe
1000aa4a4: 54ffef63    	b.lo	0x1000aa290 <_machine.convert.convert+0x428>
1000aa4a8: 940513a3    	bl	0x1001ef334 <_debug.FullPanic((function 'defaultPanic')).corruptSwitch>
1000aa4ac: eb19035f    	cmp	x26, x25
1000aa4b0: 54001108    	b.hi	0x1000aa6d0 <_machine.convert.convert+0x868>
1000aa4b4: 911c43e0    	add	x0, sp, #0x710
1000aa4b8: aa1703e1    	mov	x1, x23
1000aa4bc: aa1a03e2    	mov	x2, x26
1000aa4c0: 97fea832    	bl	0x100054588 <_decimal.decimal.Decimal.parse>
1000aa4c4: 794e63e8    	ldrh	w8, [sp, #0x730]
1000aa4c8: 35ffee48    	cbnz	w8, 0x1000aa290 <_machine.convert.convert+0x428>
1000aa4cc: a951637c    	ldp	x28, x24, [x27, #0x110]
1000aa4d0: cb1a0321    	sub	x1, x25, x26
1000aa4d4: b0000cc2    	adrp	x2, 0x100243000 <___anon_25247+0x18>
1000aa4d8: 91307842    	add	x2, x2, #0xc1e
1000aa4dc: 8b1a02e0    	add	x0, x23, x26
1000aa4e0: 52800023    	mov	w3, #0x1                ; =1
1000aa4e4: 9400a7ed    	bl	0x1000d4498 <_mem.trim__func_1557>
1000aa4e8: b4000801    	cbz	x1, 0x1000aa5e8 <_machine.convert.convert+0x780>
1000aa4ec: aa0003e3    	mov	x3, x0
1000aa4f0: aa0103e4    	mov	x4, x1
1000aa4f4: 911d03f7    	add	x23, sp, #0x740
1000aa4f8: 911d03e0    	add	x0, sp, #0x740
1000aa4fc: 911c43e2    	add	x2, sp, #0x710
1000aa500: aa1503e1    	mov	x1, x21
1000aa504: 97fe7f84    	bl	0x10004a314 <_units.Unit.parseQuantity>
1000aa508: 7950c3e8    	ldrh	w8, [sp, #0x860]
1000aa50c: 35ffec28    	cbnz	w8, 0x1000aa290 <_machine.convert.convert+0x428>
1000aa510: a954637c    	ldp	x28, x24, [x27, #0x140]
1000aa514: 910042e8    	add	x8, x23, #0x10
1000aa518: 3dc00102    	ldr	q2, [x8]
1000aa51c: ad4706e0    	ldp	q0, q1, [x23, #0xe0]
1000aa520: ad060760    	stp	q0, q1, [x27, #0xc0]
1000aa524: ad4806e0    	ldp	q0, q1, [x23, #0x100]
1000aa528: 3d803b60    	str	q0, [x27, #0xe0]
1000aa52c: ad078b61    	stp	q1, q2, [x27, #0xf0]
1000aa530: ad4506e0    	ldp	q0, q1, [x23, #0xa0]
1000aa534: ad040760    	stp	q0, q1, [x27, #0x80]
1000aa538: ad4606e0    	ldp	q0, q1, [x23, #0xc0]
1000aa53c: ad050760    	stp	q0, q1, [x27, #0xa0]
1000aa540: ad4306e0    	ldp	q0, q1, [x23, #0x60]
1000aa544: ad020760    	stp	q0, q1, [x27, #0x40]
1000aa548: ad4406e0    	ldp	q0, q1, [x23, #0x80]
1000aa54c: ad030760    	stp	q0, q1, [x27, #0x60]
1000aa550: ad4106e0    	ldp	q0, q1, [x23, #0x20]
1000aa554: ad000760    	stp	q0, q1, [x27]
1000aa558: ad4206e0    	ldp	q0, q1, [x23, #0x40]
1000aa55c: ad010760    	stp	q0, q1, [x27, #0x20]
1000aa560: 911803e0    	add	x0, sp, #0x600
1000aa564: 9113e3e1    	add	x1, sp, #0x4f8
1000aa568: 97fe7dd4    	bl	0x100049cb8 <_units.Unit.compatible>
1000aa56c: 3607e920    	tbz	w0, #0x0, 0x1000aa290 <_machine.convert.convert+0x428>
1000aa570: f9013b7c    	str	x28, [x27, #0x270]
1000aa574: f9013f78    	str	x24, [x27, #0x278]
1000aa578: 3dc04360    	ldr	q0, [x27, #0x100]
1000aa57c: 3d80a360    	str	q0, [x27, #0x280]
1000aa580: 912e83e0    	add	x0, sp, #0xba0
1000aa584: 911803e1    	add	x1, sp, #0x600
1000aa588: 9121c3e3    	add	x3, sp, #0x870
1000aa58c: aa1503e2    	mov	x2, x21
1000aa590: 52800004    	mov	w4, #0x0                ; =0
1000aa594: 97fe8360    	bl	0x10004b314 <_units.Unit.convert__func_912>
1000aa598: 3dc16b60    	ldr	q0, [x27, #0x5a0]
1000aa59c: 3dc16f61    	ldr	q1, [x27, #0x5b0]
1000aa5a0: ad148760    	stp	q0, q1, [x27, #0x290]
1000aa5a4: 795783e8    	ldrh	w8, [sp, #0xbc0]
1000aa5a8: 35ffe748    	cbnz	w8, 0x1000aa290 <_machine.convert.convert+0x428>
1000aa5ac: 912e83e0    	add	x0, sp, #0xba0
1000aa5b0: 9113e3e1    	add	x1, sp, #0x4f8
1000aa5b4: 912243e3    	add	x3, sp, #0x890
1000aa5b8: aa1503e2    	mov	x2, x21
1000aa5bc: 52800024    	mov	w4, #0x1                ; =1
1000aa5c0: 97fe8355    	bl	0x10004b314 <_units.Unit.convert__func_912>
1000aa5c4: 3dc16b60    	ldr	q0, [x27, #0x5a0]
1000aa5c8: 3dc16f61    	ldr	q1, [x27, #0x5b0]
1000aa5cc: ad158760    	stp	q0, q1, [x27, #0x2b0]
1000aa5d0: 795783e8    	ldrh	w8, [sp, #0xbc0]
1000aa5d4: 35ffe5e8    	cbnz	w8, 0x1000aa290 <_machine.convert.convert+0x428>
1000aa5d8: ad558760    	ldp	q0, q1, [x27, #0x2b0]
1000aa5dc: ad168760    	stp	q0, q1, [x27, #0x2d0]
1000aa5e0: 912343e8    	add	x8, sp, #0x8d0
1000aa5e4: 14000013    	b	0x1000aa630 <_machine.convert.convert+0x7c8>
1000aa5e8: 911c43e8    	add	x8, sp, #0x710
1000aa5ec: 91004108    	add	x8, x8, #0x10
1000aa5f0: 3dc00101    	ldr	q1, [x8]
1000aa5f4: 6f00e400    	movi.2d	v0, #0000000000000000
1000aa5f8: ad000360    	stp	q0, q0, [x27]
1000aa5fc: ad010360    	stp	q0, q0, [x27, #0x20]
1000aa600: ad020360    	stp	q0, q0, [x27, #0x40]
1000aa604: ad030360    	stp	q0, q0, [x27, #0x60]
1000aa608: ad040360    	stp	q0, q0, [x27, #0x80]
1000aa60c: ad050360    	stp	q0, q0, [x27, #0xa0]
1000aa610: ad060360    	stp	q0, q0, [x27, #0xc0]
1000aa614: 3d803b60    	str	q0, [x27, #0xe0]
1000aa618: ad078760    	stp	q0, q1, [x27, #0xf0]
1000aa61c: f9017b7c    	str	x28, [x27, #0x2f0]
1000aa620: f9017f78    	str	x24, [x27, #0x2f8]
1000aa624: 3dc04360    	ldr	q0, [x27, #0x100]
1000aa628: 9123c3e8    	add	x8, sp, #0x8f0
1000aa62c: 3d80c360    	str	q0, [x27, #0x300]
1000aa630: ad400500    	ldp	q0, q1, [x8]
1000aa634: ad188760    	stp	q0, q1, [x27, #0x310]
1000aa638: ad5186c0    	ldp	q0, q1, [x22, #0x230]
1000aa63c: ad1f8760    	stp	q0, q1, [x27, #0x3f0]
1000aa640: ad5286c0    	ldp	q0, q1, [x22, #0x250]
1000aa644: 3d810760    	str	q0, [x27, #0x410]
1000aa648: 3d810b61    	str	q1, [x27, #0x420]
1000aa64c: ad4f86c0    	ldp	q0, q1, [x22, #0x1f0]
1000aa650: ad1d8760    	stp	q0, q1, [x27, #0x3b0]
1000aa654: ad5086c0    	ldp	q0, q1, [x22, #0x210]
1000aa658: ad1e8760    	stp	q0, q1, [x27, #0x3d0]
1000aa65c: ad4d86c0    	ldp	q0, q1, [x22, #0x1b0]
1000aa660: ad1b8760    	stp	q0, q1, [x27, #0x370]
1000aa664: ad4e86c0    	ldp	q0, q1, [x22, #0x1d0]
1000aa668: ad1c8760    	stp	q0, q1, [x27, #0x390]
1000aa66c: ad4b86c0    	ldp	q0, q1, [x22, #0x170]
1000aa670: ad198760    	stp	q0, q1, [x27, #0x330]
1000aa674: ad4c86c0    	ldp	q0, q1, [x22, #0x190]
1000aa678: ad1a8760    	stp	q0, q1, [x27, #0x350]
1000aa67c: 9128c3e0    	add	x0, sp, #0xa30
1000aa680: 912443e1    	add	x1, sp, #0x910
1000aa684: 52802402    	mov	w2, #0x120              ; =288
1000aa688: 94054f1f    	bl	0x1001fe304 <_writev+0x1001fe304>
1000aa68c: 52800068    	mov	w8, #0x3                ; =3
1000aa690: b90b53e8    	str	w8, [sp, #0xb50]
1000aa694: 912da3e0    	add	x0, sp, #0xb68
1000aa698: 9128c3e2    	add	x2, sp, #0xa30
1000aa69c: aa1403e1    	mov	x1, x20
1000aa6a0: 97fe57a3    	bl	0x10004052c <_value.scalar>
1000aa6a4: 7956e3e8    	ldrh	w8, [sp, #0xb70]
1000aa6a8: 350000a8    	cbnz	w8, 0x1000aa6bc <_machine.convert.convert+0x854>
1000aa6ac: f942b768    	ldr	x8, [x27, #0x568]
1000aa6b0: f9000268    	str	x8, [x19]
1000aa6b4: 7900127f    	strh	wzr, [x19, #0x8]
1000aa6b8: 17fffecd    	b	0x1000aa1ec <_machine.convert.convert+0x384>
1000aa6bc: 79001268    	strh	w8, [x19, #0x8]
1000aa6c0: 17fffecb    	b	0x1000aa1ec <_machine.convert.convert+0x384>
1000aa6c4: 94054e6b    	bl	0x1001fe070 <_writev+0x1001fe070>
1000aa6c8: 94052a95    	bl	0x1001f511c <_debug.FullPanic((function 'defaultPanic')).integerOverflow>
1000aa6cc: 940512f6    	bl	0x1001ef2a4 <_debug.FullPanic((function 'defaultPanic')).memcpyAlias>
1000aa6d0: aa1a03e0    	mov	x0, x26
1000aa6d4: aa1903e1    	mov	x1, x25
1000aa6d8: 94052a9d    	bl	0x1001f514c <_debug.FullPanic((function 'defaultPanic')).outOfBounds>

00000001000ffc74 <_units.Unit.combine>:
1000ffc74: d106c3ff    	sub	sp, sp, #0x1b0
1000ffc78: a9156ffc    	stp	x28, x27, [sp, #0x150]
1000ffc7c: a91667fa    	stp	x26, x25, [sp, #0x160]
1000ffc80: a9175ff8    	stp	x24, x23, [sp, #0x170]
1000ffc84: a91857f6    	stp	x22, x21, [sp, #0x180]
1000ffc88: a9194ff4    	stp	x20, x19, [sp, #0x190]
1000ffc8c: a91a7bfd    	stp	x29, x30, [sp, #0x1a0]
1000ffc90: 910683fd    	add	x29, sp, #0x1a0
1000ffc94: f81a03a0    	stur	x0, [x29, #-0x60]
1000ffc98: b9400845    	ldr	w5, [x2, #0x8]
1000ffc9c: f9400851    	ldr	x17, [x2, #0x10]
1000ffca0: b940184f    	ldr	w15, [x2, #0x18]
1000ffca4: f940104d    	ldr	x13, [x2, #0x20]
1000ffca8: b940284c    	ldr	w12, [x2, #0x28]
1000ffcac: f9401849    	ldr	x9, [x2, #0x30]
1000ffcb0: b9403848    	ldr	w8, [x2, #0x38]
1000ffcb4: f940204a    	ldr	x10, [x2, #0x40]
1000ffcb8: f81903aa    	stur	x10, [x29, #-0x70]
1000ffcbc: b940484a    	ldr	w10, [x2, #0x48]
1000ffcc0: b819c3aa    	stur	w10, [x29, #-0x64]
1000ffcc4: f940284a    	ldr	x10, [x2, #0x50]
1000ffcc8: f81803aa    	stur	x10, [x29, #-0x80]
1000ffccc: b940584a    	ldr	w10, [x2, #0x58]
1000ffcd0: b81883aa    	stur	w10, [x29, #-0x78]
1000ffcd4: f940304a    	ldr	x10, [x2, #0x60]
1000ffcd8: f81703aa    	stur	x10, [x29, #-0x90]
1000ffcdc: b940684a    	ldr	w10, [x2, #0x68]
1000ffce0: b81783aa    	stur	w10, [x29, #-0x88]
1000ffce4: f940384a    	ldr	x10, [x2, #0x70]
1000ffce8: f81603aa    	stur	x10, [x29, #-0xa0]
1000ffcec: b940784a    	ldr	w10, [x2, #0x78]
1000ffcf0: b816c3aa    	stur	w10, [x29, #-0x94]
1000ffcf4: f940404a    	ldr	x10, [x2, #0x80]
1000ffcf8: f81503aa    	stur	x10, [x29, #-0xb0]
1000ffcfc: b940884a    	ldr	w10, [x2, #0x88]
1000ffd00: b815c3aa    	stur	w10, [x29, #-0xa4]
1000ffd04: f940484a    	ldr	x10, [x2, #0x90]
1000ffd08: f81383aa    	stur	x10, [x29, #-0xc8]
1000ffd0c: b940984a    	ldr	w10, [x2, #0x98]
1000ffd10: b81403aa    	stur	w10, [x29, #-0xc0]
1000ffd14: f940504a    	ldr	x10, [x2, #0xa0]
1000ffd18: f90063ea    	str	x10, [sp, #0xc0]
1000ffd1c: b940a84a    	ldr	w10, [x2, #0xa8]
1000ffd20: b900cbea    	str	w10, [sp, #0xc8]
1000ffd24: f940584a    	ldr	x10, [x2, #0xb0]
1000ffd28: f90057ea    	str	x10, [sp, #0xa8]
1000ffd2c: b940b84a    	ldr	w10, [x2, #0xb8]
1000ffd30: b900b3ea    	str	w10, [sp, #0xb0]
1000ffd34: f940604a    	ldr	x10, [x2, #0xc0]
1000ffd38: f9004bea    	str	x10, [sp, #0x90]
1000ffd3c: b940c84a    	ldr	w10, [x2, #0xc8]
1000ffd40: b9009bea    	str	w10, [sp, #0x98]
1000ffd44: 29412c20    	ldp	w0, w11, [x1, #0x8]
1000ffd48: 7100001f    	cmp	w0, #0x0
1000ffd4c: f940684a    	ldr	x10, [x2, #0xd0]
1000ffd50: f9003fea    	str	x10, [sp, #0x78]
1000ffd54: b940d84a    	ldr	w10, [x2, #0xd8]
1000ffd58: b90083ea    	str	w10, [sp, #0x80]
1000ffd5c: f940704a    	ldr	x10, [x2, #0xe0]
1000ffd60: f90033ea    	str	x10, [sp, #0x60]
1000ffd64: b940e84a    	ldr	w10, [x2, #0xe8]
1000ffd68: b9006bea    	str	w10, [sp, #0x68]
1000ffd6c: f940784a    	ldr	x10, [x2, #0xf0]
1000ffd70: f9002bea    	str	x10, [sp, #0x50]
1000ffd74: b940f84a    	ldr	w10, [x2, #0xf8]
1000ffd78: b9004fea    	str	w10, [sp, #0x4c]
1000ffd7c: 9a810055    	csel	x21, x2, x1, eq
1000ffd80: f9400839    	ldr	x25, [x1, #0x10]
1000ffd84: 29432834    	ldp	w20, w10, [x1, #0x18]
1000ffd88: 29072fea    	stp	w10, w11, [sp, #0x38]
1000ffd8c: f9401036    	ldr	x22, [x1, #0x20]
1000ffd90: 29452c3b    	ldp	w27, w11, [x1, #0x28]
1000ffd94: f940183e    	ldr	x30, [x1, #0x30]
1000ffd98: 29472838    	ldp	w24, w10, [x1, #0x38]
1000ffd9c: 29062fea    	stp	w10, w11, [sp, #0x30]
1000ffda0: f940203a    	ldr	x26, [x1, #0x40]
1000ffda4: 29492c33    	ldp	w19, w11, [x1, #0x48]
1000ffda8: f9402827    	ldr	x7, [x1, #0x50]
1000ffdac: 294b283c    	ldp	w28, w10, [x1, #0x58]
1000ffdb0: 29052fea    	stp	w10, w11, [sp, #0x28]
1000ffdb4: f9403026    	ldr	x6, [x1, #0x60]
1000ffdb8: 294d2c22    	ldp	w2, w11, [x1, #0x68]
1000ffdbc: f9403824    	ldr	x4, [x1, #0x70]
1000ffdc0: 294f2830    	ldp	w16, w10, [x1, #0x78]
1000ffdc4: 29042fea    	stp	w10, w11, [sp, #0x20]
1000ffdc8: f940402e    	ldr	x14, [x1, #0x80]
1000ffdcc: 2951282b    	ldp	w11, w10, [x1, #0x88]
1000ffdd0: b9001fea    	str	w10, [sp, #0x1c]
1000ffdd4: f940482a    	ldr	x10, [x1, #0x90]
1000ffdd8: b9409837    	ldr	w23, [x1, #0x98]
1000ffddc: b81483b7    	stur	w23, [x29, #-0xb8]
1000ffde0: b9409c37    	ldr	w23, [x1, #0x9c]
1000ffde4: b9001bf7    	str	w23, [sp, #0x18]
1000ffde8: f9405037    	ldr	x23, [x1, #0xa0]
1000ffdec: f9005ff7    	str	x23, [sp, #0xb8]
1000ffdf0: b940a837    	ldr	w23, [x1, #0xa8]
1000ffdf4: b900d3f7    	str	w23, [sp, #0xd0]
1000ffdf8: b940ac37    	ldr	w23, [x1, #0xac]
1000ffdfc: b90013f7    	str	w23, [sp, #0x10]
1000ffe00: f9405837    	ldr	x23, [x1, #0xb0]
1000ffe04: f90053f7    	str	x23, [sp, #0xa0]
1000ffe08: b940b837    	ldr	w23, [x1, #0xb8]
1000ffe0c: b900b7f7    	str	w23, [sp, #0xb4]
1000ffe10: b940bc37    	ldr	w23, [x1, #0xbc]
1000ffe14: b90017f7    	str	w23, [sp, #0x14]
1000ffe18: f9406037    	ldr	x23, [x1, #0xc0]
1000ffe1c: f90047f7    	str	x23, [sp, #0x88]
1000ffe20: b940c837    	ldr	w23, [x1, #0xc8]
1000ffe24: b9009ff7    	str	w23, [sp, #0x9c]
1000ffe28: b940cc37    	ldr	w23, [x1, #0xcc]
1000ffe2c: b9000bf7    	str	w23, [sp, #0x8]
1000ffe30: f9406837    	ldr	x23, [x1, #0xd0]
1000ffe34: f9003bf7    	str	x23, [sp, #0x70]
1000ffe38: b940d837    	ldr	w23, [x1, #0xd8]
1000ffe3c: b90087f7    	str	w23, [sp, #0x84]
1000ffe40: b940dc37    	ldr	w23, [x1, #0xdc]
1000ffe44: b9000ff7    	str	w23, [sp, #0xc]
1000ffe48: f9407037    	ldr	x23, [x1, #0xe0]
1000ffe4c: f9002ff7    	str	x23, [sp, #0x58]
1000ffe50: b940e837    	ldr	w23, [x1, #0xe8]
1000ffe54: b9006ff7    	str	w23, [sp, #0x6c]
1000ffe58: b940ec37    	ldr	w23, [x1, #0xec]
1000ffe5c: b90003f7    	str	w23, [sp]
1000ffe60: f9407837    	ldr	x23, [x1, #0xf0]
1000ffe64: f90023f7    	str	x23, [sp, #0x40]
1000ffe68: 295f0437    	ldp	w23, w1, [x1, #0xf8]
1000ffe6c: b90007e1    	str	w1, [sp, #0x4]
1000ffe70: f94002a1    	ldr	x1, [x21]
1000ffe74: 360012a3    	tbz	w3, #0x0, 0x1001000c8 <_units.Unit.combine+0x454>
1000ffe78: 6b0503e3    	negs	w3, w5
1000ffe7c: 54003066    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000ffe80: 2b030003    	adds	w3, w0, w3
1000ffe84: 54001e66    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000ffe88: 7100029f    	cmp	w20, #0x0
1000ffe8c: 9a990225    	csel	x5, x17, x25, eq
1000ffe90: 6b0f03ef    	negs	w15, w15
1000ffe94: 54002fa6    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000ffe98: 2b0f0294    	adds	w20, w20, w15
1000ffe9c: 54001da6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000ffea0: 7100037f    	cmp	w27, #0x0
1000ffea4: 9a9601b5    	csel	x21, x13, x22, eq
1000ffea8: 6b0c03ec    	negs	w12, w12
1000ffeac: 54002ee6    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000ffeb0: 2b0c0379    	adds	w25, w27, w12
1000ffeb4: 54001ce6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000ffeb8: 7100031f    	cmp	w24, #0x0
1000ffebc: 9a9e013b    	csel	x27, x9, x30, eq
1000ffec0: 6b0803e8    	negs	w8, w8
1000ffec4: 54002e26    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000ffec8: 2b080309    	adds	w9, w24, w8
1000ffecc: 54001c26    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000ffed0: 7100027f    	cmp	w19, #0x0
1000ffed4: f85903a8    	ldur	x8, [x29, #-0x70]
1000ffed8: 9a9a011a    	csel	x26, x8, x26, eq
1000ffedc: b859c3a8    	ldur	w8, [x29, #-0x64]
1000ffee0: 6b0803e8    	negs	w8, w8
1000ffee4: 54002d26    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000ffee8: 2b080273    	adds	w19, w19, w8
1000ffeec: 54001b26    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000ffef0: 7100039f    	cmp	w28, #0x0
1000ffef4: f85803a8    	ldur	x8, [x29, #-0x80]
1000ffef8: 9a870107    	csel	x7, x8, x7, eq
1000ffefc: b85883a8    	ldur	w8, [x29, #-0x78]
1000fff00: 6b0803e8    	negs	w8, w8
1000fff04: 54002c26    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000fff08: 2b08038c    	adds	w12, w28, w8
1000fff0c: 54001a26    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000fff10: 7100005f    	cmp	w2, #0x0
1000fff14: f85703a8    	ldur	x8, [x29, #-0x90]
1000fff18: 9a86010d    	csel	x13, x8, x6, eq
1000fff1c: b85783a8    	ldur	w8, [x29, #-0x88]
1000fff20: 6b0803e8    	negs	w8, w8
1000fff24: 54002b26    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000fff28: 2b08004f    	adds	w15, w2, w8
1000fff2c: 54001926    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000fff30: 7100021f    	cmp	w16, #0x0
1000fff34: f85603a8    	ldur	x8, [x29, #-0xa0]
1000fff38: 9a840111    	csel	x17, x8, x4, eq
1000fff3c: b856c3a8    	ldur	w8, [x29, #-0x94]
1000fff40: 6b0803e8    	negs	w8, w8
1000fff44: 54002a26    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000fff48: 2b080210    	adds	w16, w16, w8
1000fff4c: 54001826    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000fff50: 7100017f    	cmp	w11, #0x0
1000fff54: f85503a8    	ldur	x8, [x29, #-0xb0]
1000fff58: 9a8e010e    	csel	x14, x8, x14, eq
1000fff5c: b855c3a8    	ldur	w8, [x29, #-0xa4]
1000fff60: 6b0803e8    	negs	w8, w8
1000fff64: 54002926    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000fff68: 2b08016b    	adds	w11, w11, w8
1000fff6c: 54001726    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000fff70: b85483a8    	ldur	w8, [x29, #-0xb8]
1000fff74: 7100011f    	cmp	w8, #0x0
1000fff78: f85383a8    	ldur	x8, [x29, #-0xc8]
1000fff7c: 9a8a010a    	csel	x10, x8, x10, eq
1000fff80: b85403a8    	ldur	w8, [x29, #-0xc0]
1000fff84: 6b0803e8    	negs	w8, w8
1000fff88: 54002806    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000fff8c: b85483a0    	ldur	w0, [x29, #-0xb8]
1000fff90: 2b080000    	adds	w0, w0, w8
1000fff94: 540015e6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000fff98: b940d3e8    	ldr	w8, [sp, #0xd0]
1000fff9c: 7100011f    	cmp	w8, #0x0
1000fffa0: a94ba3e2    	ldp	x2, x8, [sp, #0xb8]
1000fffa4: 9a820102    	csel	x2, x8, x2, eq
1000fffa8: b940cbe8    	ldr	w8, [sp, #0xc8]
1000fffac: 6b0803e8    	negs	w8, w8
1000fffb0: 540026c6    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000fffb4: b940d3e4    	ldr	w4, [sp, #0xd0]
1000fffb8: 2b080084    	adds	w4, w4, w8
1000fffbc: 540014a6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000fffc0: b940b7e8    	ldr	w8, [sp, #0xb4]
1000fffc4: 7100011f    	cmp	w8, #0x0
1000fffc8: a94a23e6    	ldp	x6, x8, [sp, #0xa0]
1000fffcc: 9a860106    	csel	x6, x8, x6, eq
1000fffd0: b940b3e8    	ldr	w8, [sp, #0xb0]
1000fffd4: 6b0803e8    	negs	w8, w8
1000fffd8: 54002586    	b.vs	0x100100488 <_units.Unit.combine+0x814>
1000fffdc: b940b7f6    	ldr	w22, [sp, #0xb4]
1000fffe0: 2b0802c8    	adds	w8, w22, w8
1000fffe4: b819c3a8    	stur	w8, [x29, #-0x64]
1000fffe8: 54001346    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1000fffec: b9409fe8    	ldr	w8, [sp, #0x9c]
1000ffff0: 7100011f    	cmp	w8, #0x0
1000ffff4: a948a3f6    	ldp	x22, x8, [sp, #0x88]
1000ffff8: 9a960108    	csel	x8, x8, x22, eq
1000ffffc: f81883a8    	stur	x8, [x29, #-0x78]
100100000: b9409be8    	ldr	w8, [sp, #0x98]
100100004: 6b0803e8    	negs	w8, w8
100100008: 54002406    	b.vs	0x100100488 <_units.Unit.combine+0x814>
10010000c: b9409ff6    	ldr	w22, [sp, #0x9c]
100100010: 2b0802c8    	adds	w8, w22, w8
100100014: b81903a8    	stur	w8, [x29, #-0x70]
100100018: 540011c6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
10010001c: b94087e8    	ldr	w8, [sp, #0x84]
100100020: 7100011f    	cmp	w8, #0x0
100100024: a94723f6    	ldp	x22, x8, [sp, #0x70]
100100028: 9a960108    	csel	x8, x8, x22, eq
10010002c: f81783a8    	stur	x8, [x29, #-0x88]
100100030: b94083e8    	ldr	w8, [sp, #0x80]
100100034: 6b0803e8    	negs	w8, w8
100100038: 54002286    	b.vs	0x100100488 <_units.Unit.combine+0x814>
10010003c: b94087f6    	ldr	w22, [sp, #0x84]
100100040: 2b0802c8    	adds	w8, w22, w8
100100044: b81803a8    	stur	w8, [x29, #-0x80]
100100048: 54001046    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
10010004c: b9406fe8    	ldr	w8, [sp, #0x6c]
100100050: 7100011f    	cmp	w8, #0x0
100100054: a945a3f6    	ldp	x22, x8, [sp, #0x58]
100100058: 9a96011c    	csel	x28, x8, x22, eq
10010005c: b9406be8    	ldr	w8, [sp, #0x68]
100100060: 6b0803e8    	negs	w8, w8
100100064: 54002126    	b.vs	0x100100488 <_units.Unit.combine+0x814>
100100068: b9406ff6    	ldr	w22, [sp, #0x6c]
10010006c: 2b0802de    	adds	w30, w22, w8
100100070: 54000f06    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100074: b9404fe8    	ldr	w8, [sp, #0x4c]
100100078: 6b0803e8    	negs	w8, w8
10010007c: 54002066    	b.vs	0x100100488 <_units.Unit.combine+0x814>
100100080: 710002ff    	cmp	w23, #0x0
100100084: f9402bf6    	ldr	x22, [sp, #0x50]
100100088: f94023f8    	ldr	x24, [sp, #0x40]
10010008c: 9a9802d6    	csel	x22, x22, x24, eq
100100090: 2b0802f8    	adds	w24, w23, w8
100100094: 54000de6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100098: f90063e6    	str	x6, [sp, #0xc0]
10010009c: b81503a4    	stur	w4, [x29, #-0xb0]
1001000a0: f90067e2    	str	x2, [sp, #0xc8]
1001000a4: b815c3a0    	stur	w0, [x29, #-0xa4]
1001000a8: f9006bea    	str	x10, [sp, #0xd0]
1001000ac: b81603ab    	stur	w11, [x29, #-0xa0]
1001000b0: a933c7ae    	stp	x14, x17, [x29, #-0xc8]
1001000b4: 292dbfb0    	stp	w16, w15, [x29, #-0x94]
1001000b8: f81483ad    	stur	x13, [x29, #-0xb8]
1001000bc: aa0c03e6    	mov	x6, x12
1001000c0: aa0903e4    	mov	x4, x9
1001000c4: 1400007a    	b	0x1001002ac <_units.Unit.combine+0x638>
1001000c8: 2b050003    	adds	w3, w0, w5
1001000cc: 54000c26    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1001000d0: 7100029f    	cmp	w20, #0x0
1001000d4: 9a990225    	csel	x5, x17, x25, eq
1001000d8: 2b0f0294    	adds	w20, w20, w15
1001000dc: 54000ba6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1001000e0: 7100037f    	cmp	w27, #0x0
1001000e4: 9a9601b5    	csel	x21, x13, x22, eq
1001000e8: 2b0c0379    	adds	w25, w27, w12
1001000ec: 54000b26    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1001000f0: 7100031f    	cmp	w24, #0x0
1001000f4: 9a9e013b    	csel	x27, x9, x30, eq
1001000f8: 2b080308    	adds	w8, w24, w8
1001000fc: 54000aa6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100100: 7100027f    	cmp	w19, #0x0
100100104: f85903a9    	ldur	x9, [x29, #-0x70]
100100108: 9a9a013a    	csel	x26, x9, x26, eq
10010010c: b859c3a9    	ldur	w9, [x29, #-0x64]
100100110: 2b090273    	adds	w19, w19, w9
100100114: 540009e6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100118: 7100039f    	cmp	w28, #0x0
10010011c: f85803a9    	ldur	x9, [x29, #-0x80]
100100120: 9a870127    	csel	x7, x9, x7, eq
100100124: b85883a9    	ldur	w9, [x29, #-0x78]
100100128: 2b090389    	adds	w9, w28, w9
10010012c: 54000926    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100130: 7100005f    	cmp	w2, #0x0
100100134: f85703ac    	ldur	x12, [x29, #-0x90]
100100138: 9a86018c    	csel	x12, x12, x6, eq
10010013c: b85783ad    	ldur	w13, [x29, #-0x88]
100100140: 2b0d004d    	adds	w13, w2, w13
100100144: 54000866    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100148: 7100021f    	cmp	w16, #0x0
10010014c: f85603af    	ldur	x15, [x29, #-0xa0]
100100150: 9a8401ef    	csel	x15, x15, x4, eq
100100154: b856c3b1    	ldur	w17, [x29, #-0x94]
100100158: 2b110210    	adds	w16, w16, w17
10010015c: 540007a6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100160: 7100017f    	cmp	w11, #0x0
100100164: f85503b1    	ldur	x17, [x29, #-0xb0]
100100168: 9a8e022e    	csel	x14, x17, x14, eq
10010016c: b855c3b1    	ldur	w17, [x29, #-0xa4]
100100170: 2b11016b    	adds	w11, w11, w17
100100174: 540006e6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100178: b85483a0    	ldur	w0, [x29, #-0xb8]
10010017c: 7100001f    	cmp	w0, #0x0
100100180: f85383b1    	ldur	x17, [x29, #-0xc8]
100100184: 9a8a022a    	csel	x10, x17, x10, eq
100100188: b85403b1    	ldur	w17, [x29, #-0xc0]
10010018c: 2b110011    	adds	w17, w0, w17
100100190: 54000606    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100194: b940d3e4    	ldr	w4, [sp, #0xd0]
100100198: 7100009f    	cmp	w4, #0x0
10010019c: a94b83e2    	ldp	x2, x0, [sp, #0xb8]
1001001a0: 9a820000    	csel	x0, x0, x2, eq
1001001a4: b940cbe2    	ldr	w2, [sp, #0xc8]
1001001a8: 2b020082    	adds	w2, w4, w2
1001001ac: 54000526    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1001001b0: b940b7f6    	ldr	w22, [sp, #0xb4]
1001001b4: 710002df    	cmp	w22, #0x0
1001001b8: a94a13e6    	ldp	x6, x4, [sp, #0xa0]
1001001bc: 9a860084    	csel	x4, x4, x6, eq
1001001c0: b940b3e6    	ldr	w6, [sp, #0xb0]
1001001c4: 2b0602c6    	adds	w6, w22, w6
1001001c8: b819c3a6    	stur	w6, [x29, #-0x64]
1001001cc: 54000426    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1001001d0: b9409ff6    	ldr	w22, [sp, #0x9c]
1001001d4: 710002df    	cmp	w22, #0x0
1001001d8: a9489bf8    	ldp	x24, x6, [sp, #0x88]
1001001dc: 9a9800c6    	csel	x6, x6, x24, eq
1001001e0: f81883a6    	stur	x6, [x29, #-0x78]
1001001e4: b9409be6    	ldr	w6, [sp, #0x98]
1001001e8: 2b0602c6    	adds	w6, w22, w6
1001001ec: b81903a6    	stur	w6, [x29, #-0x70]
1001001f0: 54000306    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
1001001f4: b94087f6    	ldr	w22, [sp, #0x84]
1001001f8: 710002df    	cmp	w22, #0x0
1001001fc: a9471bf8    	ldp	x24, x6, [sp, #0x70]
100100200: 9a9800c6    	csel	x6, x6, x24, eq
100100204: f81783a6    	stur	x6, [x29, #-0x88]
100100208: b94083e6    	ldr	w6, [sp, #0x80]
10010020c: 2b0602c6    	adds	w6, w22, w6
100100210: b81803a6    	stur	w6, [x29, #-0x80]
100100214: 540001e6    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100218: 294d5be6    	ldp	w6, w22, [sp, #0x68]
10010021c: 2b0602de    	adds	w30, w22, w6
100100220: 54000186    	b.vs	0x100100250 <_units.Unit.combine+0x5dc>
100100224: b9406fe6    	ldr	w6, [sp, #0x6c]
100100228: 710000df    	cmp	w6, #0x0
10010022c: a9459bf6    	ldp	x22, x6, [sp, #0x58]
100100230: 9a9600dc    	csel	x28, x6, x22, eq
100100234: 710002ff    	cmp	w23, #0x0
100100238: f9402be6    	ldr	x6, [sp, #0x50]
10010023c: f94023f6    	ldr	x22, [sp, #0x40]
100100240: 9a9600d6    	csel	x22, x6, x22, eq
100100244: b9404fe6    	ldr	w6, [sp, #0x4c]
100100248: 2b0602f8    	adds	w24, w23, w6
10010024c: 540001a7    	b.vc	0x100100280 <_units.Unit.combine+0x60c>
100100250: d0000861    	adrp	x1, 0x10020e000 <___anon_48978+0x300>
100100254: 911cc021    	add	x1, x1, #0x730
100100258: f85a03a0    	ldur	x0, [x29, #-0x60]
10010025c: 52802102    	mov	w2, #0x108              ; =264
100100260: a95a7bfd    	ldp	x29, x30, [sp, #0x1a0]
100100264: a9594ff4    	ldp	x20, x19, [sp, #0x190]
100100268: a95857f6    	ldp	x22, x21, [sp, #0x180]
10010026c: a9575ff8    	ldp	x24, x23, [sp, #0x170]
100100270: a95667fa    	ldp	x26, x25, [sp, #0x160]
100100274: a9556ffc    	ldp	x28, x27, [sp, #0x150]
100100278: 9106c3ff    	add	sp, sp, #0x1b0
10010027c: 1403f822    	b	0x1001fe304 <_writev+0x1001fe304>
100100280: f90063e4    	str	x4, [sp, #0xc0]
100100284: b81503a2    	stur	w2, [x29, #-0xb0]
100100288: f90067e0    	str	x0, [sp, #0xc8]
10010028c: b815c3b1    	stur	w17, [x29, #-0xa4]
100100290: f9006bea    	str	x10, [sp, #0xd0]
100100294: b81603ab    	stur	w11, [x29, #-0xa0]
100100298: a933bfae    	stp	x14, x15, [x29, #-0xc8]
10010029c: 292db7b0    	stp	w16, w13, [x29, #-0x94]
1001002a0: f81483ac    	stur	x12, [x29, #-0xb8]
1001002a4: aa0903e6    	mov	x6, x9
1001002a8: aa0803e4    	mov	x4, x8
1001002ac: 11cc0468    	umin	w8, w3, #0x1
1001002b0: 7100007f    	cmp	w3, #0x0
1001002b4: 52800029    	mov	w9, #0x1                ; =1
1001002b8: 9a890529    	cinc	x9, x9, ne
1001002bc: 7100029f    	cmp	w20, #0x0
1001002c0: 9a890108    	csel	x8, x8, x9, eq
1001002c4: 11cc0729    	umin	w9, w25, #0x1
1001002c8: 11cc048a    	umin	w10, w4, #0x1
1001002cc: 8b0a0129    	add	x9, x9, x10
1001002d0: 8b090108    	add	x8, x8, x9
1001002d4: 34000093    	cbz	w19, 0x1001002e4 <_units.Unit.combine+0x670>
1001002d8: 7100067f    	cmp	w19, #0x1
1001002dc: 54000421    	b.ne	0x100100360 <_units.Unit.combine+0x6ec>
1001002e0: 91000508    	add	x8, x8, #0x1
1001002e4: 34000473    	cbz	w19, 0x100100370 <_units.Unit.combine+0x6fc>
1001002e8: 11cc04c9    	umin	w9, w6, #0x1
1001002ec: 296dabab    	ldp	w11, w10, [x29, #-0x94]
1001002f0: 11cc054a    	umin	w10, w10, #0x1
1001002f4: 11cc056b    	umin	w11, w11, #0x1
1001002f8: 296bb3ad    	ldp	w13, w12, [x29, #-0xa4]
1001002fc: 11cc058c    	umin	w12, w12, #0x1
100100300: 11cc05ad    	umin	w13, w13, #0x1
100100304: b85503ae    	ldur	w14, [x29, #-0xb0]
100100308: 11cc05ce    	umin	w14, w14, #0x1
10010030c: b859c3af    	ldur	w15, [x29, #-0x64]
100100310: 11cc05ef    	umin	w15, w15, #0x1
100100314: b85903b0    	ldur	w16, [x29, #-0x70]
100100318: 11cc0610    	umin	w16, w16, #0x1
10010031c: b85803b1    	ldur	w17, [x29, #-0x80]
100100320: 11cc0631    	umin	w17, w17, #0x1
100100324: 11cc07c0    	umin	w0, w30, #0x1
100100328: 11cc0702    	umin	w2, w24, #0x1
10010032c: 8b090149    	add	x9, x10, x9
100100330: 8b0c016a    	add	x10, x11, x12
100100334: 8b0a0129    	add	x9, x9, x10
100100338: 8b0e01aa    	add	x10, x13, x14
10010033c: 8b0f014a    	add	x10, x10, x15
100100340: 8b0a0129    	add	x9, x9, x10
100100344: 8b11020a    	add	x10, x16, x17
100100348: 8b00014a    	add	x10, x10, x0
10010034c: 8b02014a    	add	x10, x10, x2
100100350: 8b0a0129    	add	x9, x9, x10
100100354: 8b080128    	add	x8, x9, x8
100100358: f100051f    	cmp	x8, #0x1
10010035c: 540000a0    	b.eq	0x100100370 <_units.Unit.combine+0x6fc>
100100360: 528012e8    	mov	w8, #0x97               ; =151
100100364: f85a03a9    	ldur	x9, [x29, #-0x60]
100100368: 79020128    	strh	w8, [x9, #0x100]
10010036c: 1400003f    	b	0x100100468 <_units.Unit.combine+0x7f4>
100100370: f85a03a8    	ldur	x8, [x29, #-0x60]
100100374: f9000101    	str	x1, [x8]
100100378: 29472be9    	ldp	w9, w10, [sp, #0x38]
10010037c: 29012903    	stp	w3, w10, [x8, #0x8]
100100380: f9000905    	str	x5, [x8, #0x10]
100100384: 29032514    	stp	w20, w9, [x8, #0x18]
100100388: f9001115    	str	x21, [x8, #0x20]
10010038c: 29462be9    	ldp	w9, w10, [sp, #0x30]
100100390: 29052919    	stp	w25, w10, [x8, #0x28]
100100394: f900191b    	str	x27, [x8, #0x30]
100100398: 29072504    	stp	w4, w9, [x8, #0x38]
10010039c: f900211a    	str	x26, [x8, #0x40]
1001003a0: 29452be9    	ldp	w9, w10, [sp, #0x28]
1001003a4: 29092913    	stp	w19, w10, [x8, #0x48]
1001003a8: f9002907    	str	x7, [x8, #0x50]
1001003ac: 290b2506    	stp	w6, w9, [x8, #0x58]
1001003b0: f85483a9    	ldur	x9, [x29, #-0xb8]
1001003b4: f9003109    	str	x9, [x8, #0x60]
1001003b8: b85703aa    	ldur	w10, [x29, #-0x90]
1001003bc: b94027e9    	ldr	w9, [sp, #0x24]
1001003c0: 290d250a    	stp	w10, w9, [x8, #0x68]
1001003c4: f85403a9    	ldur	x9, [x29, #-0xc0]
1001003c8: f9003909    	str	x9, [x8, #0x70]
1001003cc: b856c3aa    	ldur	w10, [x29, #-0x94]
1001003d0: b94023e9    	ldr	w9, [sp, #0x20]
1001003d4: 290f250a    	stp	w10, w9, [x8, #0x78]
1001003d8: f85383a9    	ldur	x9, [x29, #-0xc8]
1001003dc: f9004109    	str	x9, [x8, #0x80]
1001003e0: b85603aa    	ldur	w10, [x29, #-0xa0]
1001003e4: b9401fe9    	ldr	w9, [sp, #0x1c]
1001003e8: 2911250a    	stp	w10, w9, [x8, #0x88]
1001003ec: f9406be9    	ldr	x9, [sp, #0xd0]
1001003f0: f9004909    	str	x9, [x8, #0x90]
1001003f4: b855c3aa    	ldur	w10, [x29, #-0xa4]
1001003f8: b9401be9    	ldr	w9, [sp, #0x18]
1001003fc: 2913250a    	stp	w10, w9, [x8, #0x98]
100100400: f94067e9    	ldr	x9, [sp, #0xc8]
100100404: f9005109    	str	x9, [x8, #0xa0]
100100408: b85503aa    	ldur	w10, [x29, #-0xb0]
10010040c: b94013e9    	ldr	w9, [sp, #0x10]
100100410: 2915250a    	stp	w10, w9, [x8, #0xa8]
100100414: f94063e9    	ldr	x9, [sp, #0xc0]
100100418: f9005909    	str	x9, [x8, #0xb0]
10010041c: b859c3aa    	ldur	w10, [x29, #-0x64]
100100420: b94017e9    	ldr	w9, [sp, #0x14]
100100424: 2917250a    	stp	w10, w9, [x8, #0xb8]
100100428: f85883a9    	ldur	x9, [x29, #-0x78]
10010042c: f9006109    	str	x9, [x8, #0xc0]
100100430: b85903aa    	ldur	w10, [x29, #-0x70]
100100434: b9400be9    	ldr	w9, [sp, #0x8]
100100438: 2919250a    	stp	w10, w9, [x8, #0xc8]
10010043c: f85783a9    	ldur	x9, [x29, #-0x88]
100100440: f9006909    	str	x9, [x8, #0xd0]
100100444: b85803aa    	ldur	w10, [x29, #-0x80]
100100448: b9400fe9    	ldr	w9, [sp, #0xc]
10010044c: 291b250a    	stp	w10, w9, [x8, #0xd8]
100100450: f900711c    	str	x28, [x8, #0xe0]
100100454: 294027ea    	ldp	w10, w9, [sp]
100100458: 291d291e    	stp	w30, w10, [x8, #0xe8]
10010045c: f9007916    	str	x22, [x8, #0xf0]
100100460: 291f2518    	stp	w24, w9, [x8, #0xf8]
100100464: 7902011f    	strh	wzr, [x8, #0x100]
100100468: a95a7bfd    	ldp	x29, x30, [sp, #0x1a0]
10010046c: a9594ff4    	ldp	x20, x19, [sp, #0x190]
100100470: a95857f6    	ldp	x22, x21, [sp, #0x180]
100100474: a9575ff8    	ldp	x24, x23, [sp, #0x170]
100100478: a95667fa    	ldp	x26, x25, [sp, #0x160]
10010047c: a9556ffc    	ldp	x28, x27, [sp, #0x150]
100100480: 9106c3ff    	add	sp, sp, #0x1b0
100100484: d65f03c0    	ret
100100488: 9403d325    	bl	0x1001f511c <_debug.FullPanic((function 'defaultPanic')).integerOverflow>
