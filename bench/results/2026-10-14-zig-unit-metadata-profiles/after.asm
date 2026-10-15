
.cache/issue936/after-host:	file format mach-o arm64

Disassembly of section __TEXT,__text:

000000010004025c <_value.scalar>:
10004025c: a9bd57f6    	stp	x22, x21, [sp, #-0x30]!
100040260: a9014ff4    	stp	x20, x19, [sp, #0x10]
100040264: a9027bfd    	stp	x29, x30, [sp, #0x20]
100040268: 910083fd    	add	x29, sp, #0x20
10004026c: aa0203f4    	mov	x20, x2
100040270: aa0103f5    	mov	x21, x1
100040274: aa0003f3    	mov	x19, x0
100040278: a9402020    	ldp	x0, x8, [x1]
10004027c: b940b049    	ldr	w9, [x2, #0xb0]
100040280: 71001d3f    	cmp	w9, #0x7
100040284: 5400020c    	b.gt	0x1000402c4 <_value.scalar+0x68>
100040288: 7100193f    	cmp	w9, #0x6
10004028c: 54000360    	b.eq	0x1000402f8 <_value.scalar+0x9c>
100040290: 71001d3f    	cmp	w9, #0x7
100040294: 540002a1    	b.ne	0x1000402e8 <_value.scalar+0x8c>
100040298: f940068a    	ldr	x10, [x20, #0x8]
10004029c: b4000a2a    	cbz	x10, 0x1000403e0 <_value.scalar+0x184>
1000402a0: d2800009    	mov	x9, #0x0                ; =0
1000402a4: f940028b    	ldr	x11, [x20]
1000402a8: 9100416b    	add	x11, x11, #0x10
1000402ac: f841856c    	ldr	x12, [x11], #0x18
1000402b0: f940758c    	ldr	x12, [x12, #0xe8]
1000402b4: 9acc6529    	umax	x9, x9, x12
1000402b8: f100054a    	subs	x10, x10, #0x1
1000402bc: 54ffff81    	b.ne	0x1000402ac <_value.scalar+0x50>
1000402c0: 14000017    	b	0x10004031c <_value.scalar+0xc0>
1000402c4: 7100213f    	cmp	w9, #0x8
1000402c8: 540007e0    	b.eq	0x1000403c4 <_value.scalar+0x168>
1000402cc: 7100313f    	cmp	w9, #0xc
1000402d0: 540000c1    	b.ne	0x1000402e8 <_value.scalar+0x8c>
1000402d4: f9401689    	ldr	x9, [x20, #0x28]
1000402d8: f9407529    	ldr	x9, [x9, #0xe8]
1000402dc: b1000536    	adds	x22, x9, #0x1
1000402e0: 540008e2    	b.hs	0x1000403fc <_value.scalar+0x1a0>
1000402e4: 14000010    	b	0x100040324 <_value.scalar+0xc8>
1000402e8: 7100393f    	cmp	w9, #0xe
1000402ec: 54000962    	b.hs	0x100040418 <_value.scalar+0x1bc>
1000402f0: d2800016    	mov	x22, #0x0               ; =0
1000402f4: 1400000c    	b	0x100040324 <_value.scalar+0xc8>
1000402f8: f940068a    	ldr	x10, [x20, #0x8]
1000402fc: b40007aa    	cbz	x10, 0x1000403f0 <_value.scalar+0x194>
100040300: d2800009    	mov	x9, #0x0                ; =0
100040304: f940028b    	ldr	x11, [x20]
100040308: f840856c    	ldr	x12, [x11], #0x8
10004030c: f940758c    	ldr	x12, [x12, #0xe8]
100040310: 9acc6529    	umax	x9, x9, x12
100040314: f100054a    	subs	x10, x10, #0x1
100040318: 54ffff81    	b.ne	0x100040308 <_value.scalar+0xac>
10004031c: b1000536    	adds	x22, x9, #0x1
100040320: 540006e2    	b.hs	0x1000403fc <_value.scalar+0x1a0>
100040324: dac143fe    	xpaci	x30
100040328: f9400108    	ldr	x8, [x8]
10004032c: 52802001    	mov	w1, #0x100              ; =256
100040330: 52800082    	mov	w2, #0x4                ; =4
100040334: aa1e03e3    	mov	x3, x30
100040338: d63f0100    	blr	x8
10004033c: b4000600    	cbz	x0, 0x1000403fc <_value.scalar+0x1a0>
100040340: 4f05e540    	movi.16b	v0, #0xaa
100040344: ad070000    	stp	q0, q0, [x0, #0xe0]
100040348: ad060000    	stp	q0, q0, [x0, #0xc0]
10004034c: ad050000    	stp	q0, q0, [x0, #0xa0]
100040350: ad040000    	stp	q0, q0, [x0, #0x80]
100040354: ad030000    	stp	q0, q0, [x0, #0x60]
100040358: ad020000    	stp	q0, q0, [x0, #0x40]
10004035c: ad010000    	stp	q0, q0, [x0, #0x20]
100040360: ad000000    	stp	q0, q0, [x0]
100040364: f2400c1f    	tst	x0, #0xf
100040368: 54000561    	b.ne	0x100040414 <_value.scalar+0x1b8>
10004036c: 52800008    	mov	w8, #0x0                ; =0
100040370: 3dc002a0    	ldr	q0, [x21]
100040374: 3c8c8000    	stur	q0, [x0, #0xc8]
100040378: ad400680    	ldp	q0, q1, [x20]
10004037c: ad410e82    	ldp	q2, q3, [x20, #0x20]
100040380: ad010c02    	stp	q2, q3, [x0, #0x20]
100040384: ad000400    	stp	q0, q1, [x0]
100040388: ad420680    	ldp	q0, q1, [x20, #0x40]
10004038c: ad430e82    	ldp	q2, q3, [x20, #0x60]
100040390: ad030c02    	stp	q2, q3, [x0, #0x60]
100040394: ad020400    	stp	q0, q1, [x0, #0x40]
100040398: ad440680    	ldp	q0, q1, [x20, #0x80]
10004039c: ad450e82    	ldp	q2, q3, [x20, #0xa0]
1000403a0: ad050c02    	stp	q2, q3, [x0, #0xa0]
1000403a4: ad040400    	stp	q0, q1, [x0, #0x80]
1000403a8: 52800029    	mov	w9, #0x1                ; =1
1000403ac: f9006009    	str	x9, [x0, #0xc0]
1000403b0: 7901f01f    	strh	wzr, [x0, #0xf8]
1000403b4: a90efc16    	stp	x22, xzr, [x0, #0xe8]
1000403b8: a90dfc1f    	stp	xzr, xzr, [x0, #0xd8]
1000403bc: f9000260    	str	x0, [x19]
1000403c0: 14000010    	b	0x100040400 <_value.scalar+0x1a4>
1000403c4: a9402a89    	ldp	x9, x10, [x20]
1000403c8: f9407529    	ldr	x9, [x9, #0xe8]
1000403cc: f940754a    	ldr	x10, [x10, #0xe8]
1000403d0: 9aca6529    	umax	x9, x9, x10
1000403d4: b1000536    	adds	x22, x9, #0x1
1000403d8: 54000122    	b.hs	0x1000403fc <_value.scalar+0x1a0>
1000403dc: 17ffffd2    	b	0x100040324 <_value.scalar+0xc8>
1000403e0: d2800009    	mov	x9, #0x0                ; =0
1000403e4: b1000536    	adds	x22, x9, #0x1
1000403e8: 54fff9e3    	b.lo	0x100040324 <_value.scalar+0xc8>
1000403ec: 14000004    	b	0x1000403fc <_value.scalar+0x1a0>
1000403f0: d2800009    	mov	x9, #0x0                ; =0
1000403f4: b1000536    	adds	x22, x9, #0x1
1000403f8: 54fff963    	b.lo	0x100040324 <_value.scalar+0xc8>
1000403fc: 528000a8    	mov	w8, #0x5                ; =5
100040400: 79001268    	strh	w8, [x19, #0x8]
100040404: a9427bfd    	ldp	x29, x30, [sp, #0x20]
100040408: a9414ff4    	ldp	x20, x19, [sp, #0x10]
10004040c: a8c357f6    	ldp	x22, x21, [sp], #0x30
100040410: d65f03c0    	ret
100040414: 9406b78f    	bl	0x1001ee250 <_debug.FullPanic((function 'defaultPanic')).incorrectAlignment>
100040418: 9406b683    	bl	0x1001ede24 <_debug.FullPanic((function 'defaultPanic')).corruptSwitch>

0000000100049914 <_units.Unit.compatible>:
100049914: d106c3ff    	sub	sp, sp, #0x1b0
100049918: a9196ffc    	stp	x28, x27, [sp, #0x190]
10004991c: a91a7bfd    	stp	x29, x30, [sp, #0x1a0]
100049920: 910683fd    	add	x29, sp, #0x1a0
100049924: 900012e8    	adrp	x8, 0x1002a5000 <___anon_137490+0x38>
100049928: f9470908    	ldr	x8, [x8, #0xe10]
10004992c: f9400108    	ldr	x8, [x8]
100049930: f81e83a8    	stur	x8, [x29, #-0x18]
100049934: 6f00e400    	movi.2d	v0, #0000000000000000
100049938: ad3e03a0    	stp	q0, q0, [x29, #-0x40]
10004993c: ad3d03a0    	stp	q0, q0, [x29, #-0x60]
100049940: ad3c03a0    	stp	q0, q0, [x29, #-0x80]
100049944: ad3b03a0    	stp	q0, q0, [x29, #-0xa0]
100049948: 79410009    	ldrh	w9, [x0, #0x80]
10004994c: f0000e08    	adrp	x8, 0x10020c000 <___anon_47293+0x28>
100049950: 910a0108    	add	x8, x8, #0x280
100049954: 34000289    	cbz	w9, 0x1000499a4 <_units.Unit.compatible+0x90>
100049958: d10283aa    	sub	x10, x29, #0xa0
10004995c: 5ac0192c    	ctz	w12, w9
100049960: 8b2c510b    	add	x11, x8, w12, uxtw #4
100049964: f940056d    	ldr	x13, [x11, #0x8]
100049968: d37d7d8c    	ubfiz	x12, x12, #3, #32
10004996c: b8ac680e    	ldrsw	x14, [x0, x12]
100049970: 9b0d7dcc    	mul	x12, x14, x13
100049974: 9b4d7dcd    	smulh	x13, x14, x13
100049978: eb8cfdbf    	cmp	x13, x12, asr #63
10004997c: 54000861    	b.ne	0x100049a88 <_units.Unit.compatible+0x174>
100049980: f940016b    	ldr	x11, [x11]
100049984: f86b794d    	ldr	x13, [x10, x11, lsl #3]
100049988: ab0c01ac    	adds	x12, x13, x12
10004998c: 540007e6    	b.vs	0x100049a88 <_units.Unit.compatible+0x174>
100049990: 5100052d    	sub	w13, w9, #0x1
100049994: 0a0901a9    	and	w9, w13, w9
100049998: f82b794c    	str	x12, [x10, x11, lsl #3]
10004999c: 72003d3f    	tst	w9, #0xffff
1000499a0: 54fffde1    	b.ne	0x10004995c <_units.Unit.compatible+0x48>
1000499a4: ad7d0ba1    	ldp	q1, q2, [x29, #-0x60]
1000499a8: ad020be1    	stp	q1, q2, [sp, #0x40]
1000499ac: ad7e0ba1    	ldp	q1, q2, [x29, #-0x40]
1000499b0: ad030be1    	stp	q1, q2, [sp, #0x60]
1000499b4: ad7b0ba1    	ldp	q1, q2, [x29, #-0xa0]
1000499b8: ad000be1    	stp	q1, q2, [sp]
1000499bc: ad7c0ba1    	ldp	q1, q2, [x29, #-0x80]
1000499c0: ad010be1    	stp	q1, q2, [sp, #0x20]
1000499c4: ad3e03a0    	stp	q0, q0, [x29, #-0x40]
1000499c8: ad3d03a0    	stp	q0, q0, [x29, #-0x60]
1000499cc: ad3c03a0    	stp	q0, q0, [x29, #-0x80]
1000499d0: ad3b03a0    	stp	q0, q0, [x29, #-0xa0]
1000499d4: 79410029    	ldrh	w9, [x1, #0x80]
1000499d8: 34000289    	cbz	w9, 0x100049a28 <_units.Unit.compatible+0x114>
1000499dc: d10283aa    	sub	x10, x29, #0xa0
1000499e0: 5ac0192c    	ctz	w12, w9
1000499e4: 8b2c510b    	add	x11, x8, w12, uxtw #4
1000499e8: f940056d    	ldr	x13, [x11, #0x8]
1000499ec: d37d7d8c    	ubfiz	x12, x12, #3, #32
1000499f0: b8ac682e    	ldrsw	x14, [x1, x12]
1000499f4: 9b0d7dcc    	mul	x12, x14, x13
1000499f8: 9b4d7dcd    	smulh	x13, x14, x13
1000499fc: eb8cfdbf    	cmp	x13, x12, asr #63
100049a00: 54000441    	b.ne	0x100049a88 <_units.Unit.compatible+0x174>
100049a04: f940016b    	ldr	x11, [x11]
100049a08: f86b794d    	ldr	x13, [x10, x11, lsl #3]
100049a0c: ab0c01ac    	adds	x12, x13, x12
100049a10: 540003c6    	b.vs	0x100049a88 <_units.Unit.compatible+0x174>
100049a14: 5100052d    	sub	w13, w9, #0x1
100049a18: 0a0901a9    	and	w9, w13, w9
100049a1c: f82b794c    	str	x12, [x10, x11, lsl #3]
100049a20: 72003d3f    	tst	w9, #0xffff
100049a24: 54fffde1    	b.ne	0x1000499e0 <_units.Unit.compatible+0xcc>
100049a28: ad7d07a0    	ldp	q0, q1, [x29, #-0x60]
100049a2c: ad0607e0    	stp	q0, q1, [sp, #0xc0]
100049a30: ad7e07a0    	ldp	q0, q1, [x29, #-0x40]
100049a34: ad0707e0    	stp	q0, q1, [sp, #0xe0]
100049a38: ad7b07a0    	ldp	q0, q1, [x29, #-0xa0]
100049a3c: ad0407e0    	stp	q0, q1, [sp, #0x80]
100049a40: ad7c07a0    	ldp	q0, q1, [x29, #-0x80]
100049a44: ad0507e0    	stp	q0, q1, [sp, #0xa0]
100049a48: 910003e0    	mov	x0, sp
100049a4c: 910203e2    	add	x2, sp, #0x80
100049a50: 52801001    	mov	w1, #0x80               ; =128
100049a54: 52801003    	mov	w3, #0x80               ; =128
100049a58: 97ffc557    	bl	0x10003afb4 <_mem.eqlBytes>
100049a5c: f85e83a8    	ldur	x8, [x29, #-0x18]
100049a60: 900012e9    	adrp	x9, 0x1002a5000 <___anon_137490+0x38>
100049a64: f9470929    	ldr	x9, [x9, #0xe10]
100049a68: f9400129    	ldr	x9, [x9]
100049a6c: eb08013f    	cmp	x9, x8
100049a70: 540000e1    	b.ne	0x100049a8c <_units.Unit.compatible+0x178>
100049a74: 12000000    	and	w0, w0, #0x1
100049a78: a95a7bfd    	ldp	x29, x30, [sp, #0x1a0]
100049a7c: a9596ffc    	ldp	x28, x27, [sp, #0x190]
100049a80: 9106c3ff    	add	sp, sp, #0x1b0
100049a84: d65f03c0    	ret
100049a88: 9406a861    	bl	0x1001f3c0c <_debug.FullPanic((function 'defaultPanic')).integerOverflow>
100049a8c: 9406cc13    	bl	0x1001fcad8 <_writev+0x1001fcad8>

00000001000a8830 <_machine.convert.prepared>:
1000a8830: a9ba6ffc    	stp	x28, x27, [sp, #-0x60]!
1000a8834: a90167fa    	stp	x26, x25, [sp, #0x10]
1000a8838: a9025ff8    	stp	x24, x23, [sp, #0x20]
1000a883c: a90357f6    	stp	x22, x21, [sp, #0x30]
1000a8840: a9044ff4    	stp	x20, x19, [sp, #0x40]
1000a8844: a9057bfd    	stp	x29, x30, [sp, #0x50]
1000a8848: 910143fd    	add	x29, sp, #0x50
1000a884c: d12a43ff    	sub	sp, sp, #0xa90
1000a8850: aa1e03f6    	mov	x22, x30
1000a8854: aa0603f7    	mov	x23, x6
1000a8858: aa0503f9    	mov	x25, x5
1000a885c: aa0403fa    	mov	x26, x4
1000a8860: aa0303f8    	mov	x24, x3
1000a8864: aa0203f4    	mov	x20, x2
1000a8868: aa0103f5    	mov	x21, x1
1000a886c: aa0003fc    	mov	x28, x0
1000a8870: 910ec3f3    	add	x19, sp, #0x3b0
1000a8874: b0000fe8    	adrp	x8, 0x1002a5000 <___anon_137490+0x38>
1000a8878: f9470908    	ldr	x8, [x8, #0xe10]
1000a887c: f9400108    	ldr	x8, [x8]
1000a8880: f81983a8    	stur	x8, [x29, #-0x68]
1000a8884: f10000bf    	cmp	x5, #0x0
1000a8888: 9a9f149b    	csinc	x27, x4, xzr, ne
1000a888c: b0000d22    	adrp	x2, 0x10024d000 <___anon_92596+0x15>
1000a8890: 910a0c42    	add	x2, x2, #0x283
1000a8894: aa1b03e0    	mov	x0, x27
1000a8898: aa0503e1    	mov	x1, x5
1000a889c: 52800083    	mov	w3, #0x4                ; =4
1000a88a0: 97fe49c5    	bl	0x10003afb4 <_mem.eqlBytes>
1000a88a4: 360004c0    	tbz	w0, #0x0, 0x1000a893c <_machine.convert.prepared+0x10c>
1000a88a8: b940b308    	ldr	w8, [x24, #0xb0]
1000a88ac: 7100151f    	cmp	w8, #0x5
1000a88b0: 540008a1    	b.ne	0x1000a89c4 <_machine.convert.prepared+0x194>
1000a88b4: a9406317    	ldp	x23, x24, [x24]
1000a88b8: aa1703e0    	mov	x0, x23
1000a88bc: aa1803e1    	mov	x1, x24
1000a88c0: 97fee102    	bl	0x100060cc8 <_unicode.utf8.validate>
1000a88c4: 360010e0    	tbz	w0, #0x0, 0x1000a8ae0 <_machine.convert.prepared+0x2b0>
1000a88c8: a9406695    	ldp	x21, x25, [x20]
1000a88cc: aa1703e0    	mov	x0, x23
1000a88d0: aa1803e1    	mov	x1, x24
1000a88d4: 97fee0fd    	bl	0x100060cc8 <_unicode.utf8.validate>
1000a88d8: 36000fe0    	tbz	w0, #0x0, 0x1000a8ad4 <_machine.convert.prepared+0x2a4>
1000a88dc: 912623e0    	add	x0, sp, #0x988
1000a88e0: aa1403e1    	mov	x1, x20
1000a88e4: aa1703e2    	mov	x2, x23
1000a88e8: aa1803e3    	mov	x3, x24
1000a88ec: 97fec854    	bl	0x10005aa3c <_unicode.normalize.nfc>
1000a88f0: 795333fa    	ldrh	w26, [sp, #0x998]
1000a88f4: 35000c5a    	cbnz	w26, 0x1000a8a7c <_machine.convert.prepared+0x24c>
1000a88f8: f942ee78    	ldr	x24, [x19, #0x5d8]
1000a88fc: f942f277    	ldr	x23, [x19, #0x5e0]
1000a8900: f9030278    	str	x24, [x19, #0x600]
1000a8904: f9030677    	str	x23, [x19, #0x608]
1000a8908: 52800088    	mov	w8, #0x4                ; =4
1000a890c: b90a63e8    	str	w8, [sp, #0xa60]
1000a8910: 912683e0    	add	x0, sp, #0x9a0
1000a8914: 9126c3e2    	add	x2, sp, #0x9b0
1000a8918: aa1403e1    	mov	x1, x20
1000a891c: 97fe5e50    	bl	0x10004025c <_value.scalar>
1000a8920: 795353fa    	ldrh	w26, [sp, #0x9a8]
1000a8924: 3500093a    	cbnz	w26, 0x1000a8a48 <_machine.convert.prepared+0x218>
1000a8928: f942fa68    	ldr	x8, [x19, #0x5f0]
1000a892c: 790083ff    	strh	wzr, [sp, #0x40]
1000a8930: f9001fe8    	str	x8, [sp, #0x38]
1000a8934: 9100e3e8    	add	x8, sp, #0x38
1000a8938: 140000af    	b	0x1000a8bf4 <_machine.convert.prepared+0x3c4>
1000a893c: f90007fc    	str	x28, [sp, #0x8]
1000a8940: 9102c3fc    	add	x28, sp, #0xb0
1000a8944: b0000d22    	adrp	x2, 0x10024d000 <___anon_92596+0x15>
1000a8948: 910d9c42    	add	x2, x2, #0x367
1000a894c: aa1b03e0    	mov	x0, x27
1000a8950: aa1903e1    	mov	x1, x25
1000a8954: 528000c3    	mov	w3, #0x6                ; =6
1000a8958: 97fe4997    	bl	0x10003afb4 <_mem.eqlBytes>
1000a895c: 36000940    	tbz	w0, #0x0, 0x1000a8a84 <_machine.convert.prepared+0x254>
1000a8960: b940b308    	ldr	w8, [x24, #0xb0]
1000a8964: 7100091f    	cmp	w8, #0x2
1000a8968: 54000ea0    	b.eq	0x1000a8b3c <_machine.convert.prepared+0x30c>
1000a896c: 7100111f    	cmp	w8, #0x4
1000a8970: 54000f61    	b.ne	0x1000a8b5c <_machine.convert.prepared+0x32c>
1000a8974: a9400b01    	ldp	x1, x2, [x24]
1000a8978: 910203e0    	add	x0, sp, #0x80
1000a897c: 97feafb5    	bl	0x100054850 <_decimal.decimal.Decimal.parse>
1000a8980: 794143e8    	ldrh	w8, [sp, #0xa0]
1000a8984: 35001248    	cbnz	w8, 0x1000a8bcc <_machine.convert.prepared+0x39c>
1000a8988: ad4407e0    	ldp	q0, q1, [sp, #0x80]
1000a898c: ad000780    	stp	q0, q1, [x28]
1000a8990: 52800048    	mov	w8, #0x2                ; =2
1000a8994: b90163e8    	str	w8, [sp, #0x160]
1000a8998: 9105c3e0    	add	x0, sp, #0x170
1000a899c: 9102c3e2    	add	x2, sp, #0xb0
1000a89a0: aa1403e1    	mov	x1, x20
1000a89a4: 97fe5e2e    	bl	0x10004025c <_value.scalar>
1000a89a8: 7942f3e8    	ldrh	w8, [sp, #0x178]
1000a89ac: 35004248    	cbnz	w8, 0x1000a91f4 <_machine.convert.prepared+0x9c4>
1000a89b0: f9406388    	ldr	x8, [x28, #0xc0]
1000a89b4: 790313ff    	strh	wzr, [sp, #0x188]
1000a89b8: f9006b88    	str	x8, [x28, #0xd0]
1000a89bc: 910603e8    	add	x8, sp, #0x180
1000a89c0: 14000085    	b	0x1000a8bd4 <_machine.convert.prepared+0x3a4>
1000a89c4: 7100391f    	cmp	w8, #0xe
1000a89c8: 54004262    	b.hs	0x1000a9214 <_machine.convert.prepared+0x9e4>
1000a89cc: 910123e0    	add	x0, sp, #0x48
1000a89d0: aa1503e1    	mov	x1, x21
1000a89d4: aa1803e2    	mov	x2, x24
1000a89d8: 940150fe    	bl	0x1000fcdd0 <_machine.chunks.textForm>
1000a89dc: 7940b3e8    	ldrh	w8, [sp, #0x58]
1000a89e0: 35004068    	cbnz	w8, 0x1000a91ec <_machine.convert.prepared+0x9bc>
1000a89e4: a944e3f7    	ldp	x23, x24, [sp, #0x48]
1000a89e8: a9406695    	ldp	x21, x25, [x20]
1000a89ec: aa1703e0    	mov	x0, x23
1000a89f0: aa1803e1    	mov	x1, x24
1000a89f4: 97fee0b5    	bl	0x100060cc8 <_unicode.utf8.validate>
1000a89f8: 360006e0    	tbz	w0, #0x0, 0x1000a8ad4 <_machine.convert.prepared+0x2a4>
1000a89fc: 912623e0    	add	x0, sp, #0x988
1000a8a00: aa1403e1    	mov	x1, x20
1000a8a04: aa1703e2    	mov	x2, x23
1000a8a08: aa1803e3    	mov	x3, x24
1000a8a0c: 97fec80c    	bl	0x10005aa3c <_unicode.normalize.nfc>
1000a8a10: 795333fa    	ldrh	w26, [sp, #0x998]
1000a8a14: 3500035a    	cbnz	w26, 0x1000a8a7c <_machine.convert.prepared+0x24c>
1000a8a18: f942ee78    	ldr	x24, [x19, #0x5d8]
1000a8a1c: f942f277    	ldr	x23, [x19, #0x5e0]
1000a8a20: f9030278    	str	x24, [x19, #0x600]
1000a8a24: f9030677    	str	x23, [x19, #0x608]
1000a8a28: 52800088    	mov	w8, #0x4                ; =4
1000a8a2c: b90a63e8    	str	w8, [sp, #0xa60]
1000a8a30: 912683e0    	add	x0, sp, #0x9a0
1000a8a34: 9126c3e2    	add	x2, sp, #0x9b0
1000a8a38: aa1403e1    	mov	x1, x20
1000a8a3c: 97fe5e08    	bl	0x10004025c <_value.scalar>
1000a8a40: 795353fa    	ldrh	w26, [sp, #0x9a8]
1000a8a44: 34000d1a    	cbz	w26, 0x1000a8be4 <_machine.convert.prepared+0x3b4>
1000a8a48: b40001b7    	cbz	x23, 0x1000a8a7c <_machine.convert.prepared+0x24c>
1000a8a4c: aa1803e0    	mov	x0, x24
1000a8a50: 52801541    	mov	w1, #0xaa               ; =170
1000a8a54: aa1703e2    	mov	x2, x23
1000a8a58: 940550cb    	bl	0x1001fcd84 <_writev+0x1001fcd84>
1000a8a5c: dac143f6    	xpaci	x22
1000a8a60: f9400f28    	ldr	x8, [x25, #0x18]
1000a8a64: aa1503e0    	mov	x0, x21
1000a8a68: aa1803e1    	mov	x1, x24
1000a8a6c: aa1703e2    	mov	x2, x23
1000a8a70: 52800003    	mov	w3, #0x0                ; =0
1000a8a74: aa1603e4    	mov	x4, x22
1000a8a78: d63f0100    	blr	x8
1000a8a7c: 7900139a    	strh	w26, [x28, #0x8]
1000a8a80: 1400005f    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a8a84: d0000cc2    	adrp	x2, 0x100242000 <___anon_25295+0xb>
1000a8a88: 91311042    	add	x2, x2, #0xc44
1000a8a8c: aa1b03e0    	mov	x0, x27
1000a8a90: aa1903e1    	mov	x1, x25
1000a8a94: 528000a3    	mov	w3, #0x5                ; =5
1000a8a98: 97fe4947    	bl	0x10003afb4 <_mem.eqlBytes>
1000a8a9c: 36000280    	tbz	w0, #0x0, 0x1000a8aec <_machine.convert.prepared+0x2bc>
1000a8aa0: b940b308    	ldr	w8, [x24, #0xb0]
1000a8aa4: 7100111f    	cmp	w8, #0x4
1000a8aa8: 54000c60    	b.eq	0x1000a8c34 <_machine.convert.prepared+0x404>
1000a8aac: 7100151f    	cmp	w8, #0x5
1000a8ab0: 540008a1    	b.ne	0x1000a8bc4 <_machine.convert.prepared+0x394>
1000a8ab4: f9406308    	ldr	x8, [x24, #0xc0]
1000a8ab8: b1000508    	adds	x8, x8, #0x1
1000a8abc: 54003ae2    	b.hs	0x1000a9218 <_machine.convert.prepared+0x9e8>
1000a8ac0: f9006308    	str	x8, [x24, #0xc0]
1000a8ac4: 790333ff    	strh	wzr, [sp, #0x198]
1000a8ac8: 910643e8    	add	x8, sp, #0x190
1000a8acc: f9007398    	str	x24, [x28, #0xe0]
1000a8ad0: 14000041    	b	0x1000a8bd4 <_machine.convert.prepared+0x3a4>
1000a8ad4: 528012ba    	mov	w26, #0x95              ; =149
1000a8ad8: 7900139a    	strh	w26, [x28, #0x8]
1000a8adc: 14000048    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a8ae0: 90000b68    	adrp	x8, 0x100214000 <___anon_68626>
1000a8ae4: 913d6108    	add	x8, x8, #0xf58
1000a8ae8: 14000043    	b	0x1000a8bf4 <_machine.convert.prepared+0x3c4>
1000a8aec: f0000cc2    	adrp	x2, 0x100243000 <___anon_52688+0x8>
1000a8af0: 91085c42    	add	x2, x2, #0x217
1000a8af4: aa1b03e0    	mov	x0, x27
1000a8af8: aa1903e1    	mov	x1, x25
1000a8afc: 52800143    	mov	w3, #0xa                ; =10
1000a8b00: 97fe492d    	bl	0x10003afb4 <_mem.eqlBytes>
1000a8b04: 36000380    	tbz	w0, #0x0, 0x1000a8b74 <_machine.convert.prepared+0x344>
1000a8b08: b940b308    	ldr	w8, [x24, #0xb0]
1000a8b0c: 7100111f    	cmp	w8, #0x4
1000a8b10: 54001100    	b.eq	0x1000a8d30 <_machine.convert.prepared+0x500>
1000a8b14: 7100291f    	cmp	w8, #0xa
1000a8b18: 54000561    	b.ne	0x1000a8bc4 <_machine.convert.prepared+0x394>
1000a8b1c: f9406308    	ldr	x8, [x24, #0xc0]
1000a8b20: b1000508    	adds	x8, x8, #0x1
1000a8b24: 540037a2    	b.hs	0x1000a9218 <_machine.convert.prepared+0x9e8>
1000a8b28: f9006308    	str	x8, [x24, #0xc0]
1000a8b2c: 790373ff    	strh	wzr, [sp, #0x1b8]
1000a8b30: 9106c3e8    	add	x8, sp, #0x1b0
1000a8b34: f9008398    	str	x24, [x28, #0x100]
1000a8b38: 14000027    	b	0x1000a8bd4 <_machine.convert.prepared+0x3a4>
1000a8b3c: f9406308    	ldr	x8, [x24, #0xc0]
1000a8b40: b1000508    	adds	x8, x8, #0x1
1000a8b44: 540036a2    	b.hs	0x1000a9218 <_machine.convert.prepared+0x9e8>
1000a8b48: f9006308    	str	x8, [x24, #0xc0]
1000a8b4c: 7900f3ff    	strh	wzr, [sp, #0x78]
1000a8b50: 9101c3e8    	add	x8, sp, #0x70
1000a8b54: f9003bf8    	str	x24, [sp, #0x70]
1000a8b58: 1400001f    	b	0x1000a8bd4 <_machine.convert.prepared+0x3a4>
1000a8b5c: 7100391f    	cmp	w8, #0xe
1000a8b60: f94007e9    	ldr	x9, [sp, #0x8]
1000a8b64: 54003582    	b.hs	0x1000a9214 <_machine.convert.prepared+0x9e4>
1000a8b68: 90000b68    	adrp	x8, 0x100214000 <___anon_68626>
1000a8b6c: 913d6108    	add	x8, x8, #0xf58
1000a8b70: 1400001a    	b	0x1000a8bd8 <_machine.convert.prepared+0x3a8>
1000a8b74: d0000cc2    	adrp	x2, 0x100242000 <___anon_25295+0xb>
1000a8b78: 91314042    	add	x2, x2, #0xc50
1000a8b7c: aa1b03e0    	mov	x0, x27
1000a8b80: aa1903e1    	mov	x1, x25
1000a8b84: 528000e3    	mov	w3, #0x7                ; =7
1000a8b88: 97fe490b    	bl	0x10003afb4 <_mem.eqlBytes>
1000a8b8c: 36000740    	tbz	w0, #0x0, 0x1000a8c74 <_machine.convert.prepared+0x444>
1000a8b90: b940b308    	ldr	w8, [x24, #0xb0]
1000a8b94: 7100111f    	cmp	w8, #0x4
1000a8b98: 54001840    	b.eq	0x1000a8ea0 <_machine.convert.prepared+0x670>
1000a8b9c: 7100251f    	cmp	w8, #0x9
1000a8ba0: 54000121    	b.ne	0x1000a8bc4 <_machine.convert.prepared+0x394>
1000a8ba4: f9406308    	ldr	x8, [x24, #0xc0]
1000a8ba8: b1000508    	adds	x8, x8, #0x1
1000a8bac: 54003362    	b.hs	0x1000a9218 <_machine.convert.prepared+0x9e8>
1000a8bb0: f9006308    	str	x8, [x24, #0xc0]
1000a8bb4: 790563ff    	strh	wzr, [sp, #0x2b0]
1000a8bb8: 910aa3e8    	add	x8, sp, #0x2a8
1000a8bbc: f900ff98    	str	x24, [x28, #0x1f8]
1000a8bc0: 14000005    	b	0x1000a8bd4 <_machine.convert.prepared+0x3a4>
1000a8bc4: 7100391f    	cmp	w8, #0xe
1000a8bc8: 54003262    	b.hs	0x1000a9214 <_machine.convert.prepared+0x9e4>
1000a8bcc: 90000b68    	adrp	x8, 0x100214000 <___anon_68626>
1000a8bd0: 913d6108    	add	x8, x8, #0xf58
1000a8bd4: f94007e9    	ldr	x9, [sp, #0x8]
1000a8bd8: 3dc00100    	ldr	q0, [x8]
1000a8bdc: 3d800120    	str	q0, [x9]
1000a8be0: 14000007    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a8be4: f942fa68    	ldr	x8, [x19, #0x5f0]
1000a8be8: 7900d3ff    	strh	wzr, [sp, #0x68]
1000a8bec: f90033e8    	str	x8, [sp, #0x60]
1000a8bf0: 910183e8    	add	x8, sp, #0x60
1000a8bf4: 3dc00100    	ldr	q0, [x8]
1000a8bf8: 3d800380    	str	q0, [x28]
1000a8bfc: f85983a8    	ldur	x8, [x29, #-0x68]
1000a8c00: b0000fe9    	adrp	x9, 0x1002a5000 <___anon_137490+0x38>
1000a8c04: f9470929    	ldr	x9, [x9, #0xe10]
1000a8c08: f9400129    	ldr	x9, [x9]
1000a8c0c: eb08013f    	cmp	x9, x8
1000a8c10: 54003001    	b.ne	0x1000a9210 <_machine.convert.prepared+0x9e0>
1000a8c14: 912a43ff    	add	sp, sp, #0xa90
1000a8c18: a9457bfd    	ldp	x29, x30, [sp, #0x50]
1000a8c1c: a9444ff4    	ldp	x20, x19, [sp, #0x40]
1000a8c20: a94357f6    	ldp	x22, x21, [sp, #0x30]
1000a8c24: a9425ff8    	ldp	x24, x23, [sp, #0x20]
1000a8c28: a94167fa    	ldp	x26, x25, [sp, #0x10]
1000a8c2c: a8c66ffc    	ldp	x28, x27, [sp], #0x60
1000a8c30: d65f03c0    	ret
1000a8c34: a9405719    	ldp	x25, x21, [x24]
1000a8c38: a9406a97    	ldp	x23, x26, [x20]
1000a8c3c: b4000b55    	cbz	x21, 0x1000a8da4 <_machine.convert.prepared+0x574>
1000a8c40: aa1603e3    	mov	x3, x22
1000a8c44: dac143e3    	xpaci	x3
1000a8c48: f9400348    	ldr	x8, [x26]
1000a8c4c: aa1703e0    	mov	x0, x23
1000a8c50: aa1503e1    	mov	x1, x21
1000a8c54: 52800002    	mov	w2, #0x0                ; =0
1000a8c58: d63f0100    	blr	x8
1000a8c5c: b40015e0    	cbz	x0, 0x1000a8f18 <_machine.convert.prepared+0x6e8>
1000a8c60: aa0003f8    	mov	x24, x0
1000a8c64: 52801541    	mov	w1, #0xaa               ; =170
1000a8c68: aa1503e2    	mov	x2, x21
1000a8c6c: 94055046    	bl	0x1001fcd84 <_writev+0x1001fcd84>
1000a8c70: 1400004e    	b	0x1000a8da8 <_machine.convert.prepared+0x578>
1000a8c74: 3201f3e8    	mov	w8, #-0x55555556        ; =-1431655766
1000a8c78: b90433e8    	str	w8, [sp, #0x430]
1000a8c7c: 4f05e540    	movi.16b	v0, #0xaa
1000a8c80: ad030260    	stp	q0, q0, [x19, #0x60]
1000a8c84: ad020260    	stp	q0, q0, [x19, #0x40]
1000a8c88: ad010260    	stp	q0, q0, [x19, #0x20]
1000a8c8c: ad000260    	stp	q0, q0, [x19]
1000a8c90: b4000db7    	cbz	x23, 0x1000a8e44 <_machine.convert.prepared+0x614>
1000a8c94: 910202f6    	add	x22, x23, #0x80
1000a8c98: f94007fb    	ldr	x27, [sp, #0x8]
1000a8c9c: 3201f3e8    	mov	w8, #-0x55555556        ; =-1431655766
1000a8ca0: b90543e8    	str	w8, [sp, #0x540]
1000a8ca4: 4f05e540    	movi.16b	v0, #0xaa
1000a8ca8: ad0b8260    	stp	q0, q0, [x19, #0x170]
1000a8cac: ad0a8260    	stp	q0, q0, [x19, #0x150]
1000a8cb0: ad098260    	stp	q0, q0, [x19, #0x130]
1000a8cb4: ad088260    	stp	q0, q0, [x19, #0x110]
1000a8cb8: a940671a    	ldp	x26, x25, [x24]
1000a8cbc: 91004308    	add	x8, x24, #0x10
1000a8cc0: b940b309    	ldr	w9, [x24, #0xb0]
1000a8cc4: 7100093f    	cmp	w9, #0x2
1000a8cc8: 54002280    	b.eq	0x1000a9118 <_machine.convert.prepared+0x8e8>
1000a8ccc: 71000d3f    	cmp	w9, #0x3
1000a8cd0: 540012c0    	b.eq	0x1000a8f28 <_machine.convert.prepared+0x6f8>
1000a8cd4: 7100113f    	cmp	w9, #0x4
1000a8cd8: 54001761    	b.ne	0x1000a8fc4 <_machine.convert.prepared+0x794>
1000a8cdc: 90000d02    	adrp	x2, 0x100248000 <___anon_83702+0x17>
1000a8ce0: 91389842    	add	x2, x2, #0xe26
1000a8ce4: aa1a03e0    	mov	x0, x26
1000a8ce8: aa1903e1    	mov	x1, x25
1000a8cec: 52800083    	mov	w3, #0x4                ; =4
1000a8cf0: 9400a978    	bl	0x1000d32d0 <_mem.trim__func_1557>
1000a8cf4: aa0003f8    	mov	x24, x0
1000a8cf8: aa0103fb    	mov	x27, x1
1000a8cfc: d280001c    	mov	x28, #0x0               ; =0
1000a8d00: b40016e1    	cbz	x1, 0x1000a8fdc <_machine.convert.prepared+0x7ac>
1000a8d04: 387c6b08    	ldrb	w8, [x24, x28]
1000a8d08: 5100c109    	sub	w9, w8, #0x30
1000a8d0c: 5100b508    	sub	w8, w8, #0x2d
1000a8d10: 7100293f    	cmp	w9, #0xa
1000a8d14: 7a422900    	ccmp	w8, #0x2, #0x0, hs
1000a8d18: 540015e2    	b.hs	0x1000a8fd4 <_machine.convert.prepared+0x7a4>
1000a8d1c: 9100079c    	add	x28, x28, #0x1
1000a8d20: eb1c037f    	cmp	x27, x28
1000a8d24: 54ffff01    	b.ne	0x1000a8d04 <_machine.convert.prepared+0x4d4>
1000a8d28: aa1b03fc    	mov	x28, x27
1000a8d2c: 140000ac    	b	0x1000a8fdc <_machine.convert.prepared+0x7ac>
1000a8d30: a9400700    	ldp	x0, x1, [x24]
1000a8d34: 90000d02    	adrp	x2, 0x100248000 <___anon_83702+0x17>
1000a8d38: 91389842    	add	x2, x2, #0xe26
1000a8d3c: 52800083    	mov	w3, #0x4                ; =4
1000a8d40: 9400a964    	bl	0x1000d32d0 <_mem.trim__func_1557>
1000a8d44: aa0003e2    	mov	x2, x0
1000a8d48: aa0103e3    	mov	x3, x1
1000a8d4c: 910053e0    	add	x0, sp, #0x14
1000a8d50: aa0203e1    	mov	x1, x2
1000a8d54: aa0303e2    	mov	x2, x3
1000a8d58: 97fe8449    	bl	0x100049e7c <_dates.parseCivil>
1000a8d5c: 79406be8    	ldrh	w8, [sp, #0x34]
1000a8d60: 35fff368    	cbnz	w8, 0x1000a8bcc <_machine.convert.prepared+0x39c>
1000a8d64: 3cc143e0    	ldur	q0, [sp, #0x14]
1000a8d68: 3cc243e1    	ldur	q1, [sp, #0x24]
1000a8d6c: ad088780    	stp	q0, q1, [x28, #0x110]
1000a8d70: 52800148    	mov	w8, #0xa                ; =10
1000a8d74: b90273e8    	str	w8, [sp, #0x270]
1000a8d78: 910a23e0    	add	x0, sp, #0x288
1000a8d7c: 910703e2    	add	x2, sp, #0x1c0
1000a8d80: aa1403e1    	mov	x1, x20
1000a8d84: 97fe5d36    	bl	0x10004025c <_value.scalar>
1000a8d88: 794523e8    	ldrh	w8, [sp, #0x290]
1000a8d8c: 35002348    	cbnz	w8, 0x1000a91f4 <_machine.convert.prepared+0x9c4>
1000a8d90: f940ef88    	ldr	x8, [x28, #0x1d8]
1000a8d94: 790543ff    	strh	wzr, [sp, #0x2a0]
1000a8d98: f900f788    	str	x8, [x28, #0x1e8]
1000a8d9c: 910a63e8    	add	x8, sp, #0x298
1000a8da0: 17ffff8d    	b	0x1000a8bd4 <_machine.convert.prepared+0x3a4>
1000a8da4: 92800018    	mov	x24, #-0x1              ; =-1
1000a8da8: 8b150328    	add	x8, x25, x21
1000a8dac: eb08031f    	cmp	x24, x8
1000a8db0: 54000082    	b.hs	0x1000a8dc0 <_machine.convert.prepared+0x590>
1000a8db4: 8b150308    	add	x8, x24, x21
1000a8db8: eb08033f    	cmp	x25, x8
1000a8dbc: 54002303    	b.lo	0x1000a921c <_machine.convert.prepared+0x9ec>
1000a8dc0: aa1803e0    	mov	x0, x24
1000a8dc4: aa1903e1    	mov	x1, x25
1000a8dc8: aa1503e2    	mov	x2, x21
1000a8dcc: 94054fe8    	bl	0x1001fcd6c <_writev+0x1001fcd6c>
1000a8dd0: f9030278    	str	x24, [x19, #0x600]
1000a8dd4: f9030675    	str	x21, [x19, #0x608]
1000a8dd8: 528000a8    	mov	w8, #0x5                ; =5
1000a8ddc: b90a63e8    	str	w8, [sp, #0xa60]
1000a8de0: 912623e0    	add	x0, sp, #0x988
1000a8de4: 9126c3e2    	add	x2, sp, #0x9b0
1000a8de8: aa1403e1    	mov	x1, x20
1000a8dec: 97fe5d1c    	bl	0x10004025c <_value.scalar>
1000a8df0: 795323f4    	ldrh	w20, [sp, #0x990]
1000a8df4: 340001f4    	cbz	w20, 0x1000a8e30 <_machine.convert.prepared+0x600>
1000a8df8: b4000935    	cbz	x21, 0x1000a8f1c <_machine.convert.prepared+0x6ec>
1000a8dfc: aa1803e0    	mov	x0, x24
1000a8e00: 52801541    	mov	w1, #0xaa               ; =170
1000a8e04: aa1503e2    	mov	x2, x21
1000a8e08: 94054fdf    	bl	0x1001fcd84 <_writev+0x1001fcd84>
1000a8e0c: dac143f6    	xpaci	x22
1000a8e10: f9400f48    	ldr	x8, [x26, #0x18]
1000a8e14: aa1703e0    	mov	x0, x23
1000a8e18: aa1803e1    	mov	x1, x24
1000a8e1c: aa1503e2    	mov	x2, x21
1000a8e20: 52800003    	mov	w3, #0x0                ; =0
1000a8e24: aa1603e4    	mov	x4, x22
1000a8e28: d63f0100    	blr	x8
1000a8e2c: 1400003c    	b	0x1000a8f1c <_machine.convert.prepared+0x6ec>
1000a8e30: f942ee68    	ldr	x8, [x19, #0x5d8]
1000a8e34: 790353ff    	strh	wzr, [sp, #0x1a8]
1000a8e38: f9007b88    	str	x8, [x28, #0xf0]
1000a8e3c: 910683e8    	add	x8, sp, #0x1a0
1000a8e40: 17ffff65    	b	0x1000a8bd4 <_machine.convert.prepared+0x3a4>
1000a8e44: 9110e3e0    	add	x0, sp, #0x438
1000a8e48: aa1a03e1    	mov	x1, x26
1000a8e4c: aa1903e2    	mov	x2, x25
1000a8e50: 97feac7d    	bl	0x100054044 <_units.Unit.parse>
1000a8e54: 79497be8    	ldrh	w8, [sp, #0x4bc]
1000a8e58: f94007fb    	ldr	x27, [sp, #0x8]
1000a8e5c: 35000b88    	cbnz	w8, 0x1000a8fcc <_machine.convert.prepared+0x79c>
1000a8e60: 3ccd8260    	ldur	q0, [x19, #0xd8]
1000a8e64: 3cce8261    	ldur	q1, [x19, #0xe8]
1000a8e68: 3ccf8262    	ldur	q2, [x19, #0xf8]
1000a8e6c: ad030a61    	stp	q1, q2, [x19, #0x60]
1000a8e70: b944bbe8    	ldr	w8, [sp, #0x4b8]
1000a8e74: b90433e8    	str	w8, [sp, #0x430]
1000a8e78: 3cc98261    	ldur	q1, [x19, #0x98]
1000a8e7c: 3cca8262    	ldur	q2, [x19, #0xa8]
1000a8e80: 3ccb8263    	ldur	q3, [x19, #0xb8]
1000a8e84: ad010e62    	stp	q2, q3, [x19, #0x20]
1000a8e88: 3ccc8262    	ldur	q2, [x19, #0xc8]
1000a8e8c: ad020262    	stp	q2, q0, [x19, #0x40]
1000a8e90: 3cc88260    	ldur	q0, [x19, #0x88]
1000a8e94: 910ec3f6    	add	x22, sp, #0x3b0
1000a8e98: ad000660    	stp	q0, q1, [x19]
1000a8e9c: 17ffff80    	b	0x1000a8c9c <_machine.convert.prepared+0x46c>
1000a8ea0: a9400700    	ldp	x0, x1, [x24]
1000a8ea4: 90000d02    	adrp	x2, 0x100248000 <___anon_83702+0x17>
1000a8ea8: 91389842    	add	x2, x2, #0xe26
1000a8eac: 52800083    	mov	w3, #0x4                ; =4
1000a8eb0: 9400a908    	bl	0x1000d32d0 <_mem.trim__func_1557>
1000a8eb4: aa0003e2    	mov	x2, x0
1000a8eb8: aa0103e3    	mov	x3, x1
1000a8ebc: 910ae3e0    	add	x0, sp, #0x2b8
1000a8ec0: aa0203e1    	mov	x1, x2
1000a8ec4: aa0303e2    	mov	x2, x3
1000a8ec8: 97feaf3e    	bl	0x100054bc0 <_dates.parseInstant>
1000a8ecc: 794593e8    	ldrh	w8, [sp, #0x2c8]
1000a8ed0: 35ffe7e8    	cbnz	w8, 0x1000a8bcc <_machine.convert.prepared+0x39c>
1000a8ed4: 910ae3f3    	add	x19, sp, #0x2b8
1000a8ed8: 3dc00260    	ldr	q0, [x19]
1000a8edc: 3c818260    	stur	q0, [x19, #0x18]
1000a8ee0: 52800128    	mov	w8, #0x9                ; =9
1000a8ee4: b90383e8    	str	w8, [sp, #0x380]
1000a8ee8: 910e43e0    	add	x0, sp, #0x390
1000a8eec: 910b43e2    	add	x2, sp, #0x2d0
1000a8ef0: aa1403e1    	mov	x1, x20
1000a8ef4: 97fe5cda    	bl	0x10004025c <_value.scalar>
1000a8ef8: 794733e8    	ldrh	w8, [sp, #0x398]
1000a8efc: f94007e9    	ldr	x9, [sp, #0x8]
1000a8f00: 35001848    	cbnz	w8, 0x1000a9208 <_machine.convert.prepared+0x9d8>
1000a8f04: f9406e68    	ldr	x8, [x19, #0xd8]
1000a8f08: 790753ff    	strh	wzr, [sp, #0x3a8]
1000a8f0c: f9007668    	str	x8, [x19, #0xe8]
1000a8f10: 910e83e8    	add	x8, sp, #0x3a0
1000a8f14: 17ffff31    	b	0x1000a8bd8 <_machine.convert.prepared+0x3a8>
1000a8f18: 528000b4    	mov	w20, #0x5               ; =5
1000a8f1c: f94007e8    	ldr	x8, [sp, #0x8]
1000a8f20: 79001114    	strh	w20, [x8, #0x8]
1000a8f24: 17ffff36    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a8f28: 3dc00100    	ldr	q0, [x8]
1000a8f2c: 3d806a60    	str	q0, [x19, #0x1a0]
1000a8f30: 91008318    	add	x24, x24, #0x20
1000a8f34: b4000a77    	cbz	x23, 0x1000a9080 <_machine.convert.prepared+0x850>
1000a8f38: 911943e0    	add	x0, sp, #0x650
1000a8f3c: aa1803e1    	mov	x1, x24
1000a8f40: 97fe82d4    	bl	0x100049a90 <_units.Unit.dimensions>
1000a8f44: 911943e0    	add	x0, sp, #0x650
1000a8f48: 52801001    	mov	w1, #0x80               ; =128
1000a8f4c: aa1703e2    	mov	x2, x23
1000a8f50: 52801003    	mov	w3, #0x80               ; =128
1000a8f54: 97fe4818    	bl	0x10003afb4 <_mem.eqlBytes>
1000a8f58: 360003a0    	tbz	w0, #0x0, 0x1000a8fcc <_machine.convert.prepared+0x79c>
1000a8f5c: f901927a    	str	x26, [x19, #0x320]
1000a8f60: f9019679    	str	x25, [x19, #0x328]
1000a8f64: 3dc06a60    	ldr	q0, [x19, #0x1a0]
1000a8f68: 3d80ce60    	str	q0, [x19, #0x330]
1000a8f6c: 9126c3e0    	add	x0, sp, #0x9b0
1000a8f70: 911b43e3    	add	x3, sp, #0x6d0
1000a8f74: aa1803e1    	mov	x1, x24
1000a8f78: aa1503e2    	mov	x2, x21
1000a8f7c: 52800004    	mov	w4, #0x0                ; =0
1000a8f80: 97fe8911    	bl	0x10004b3c4 <_units.Unit.convert__func_913>
1000a8f84: 3dc18260    	ldr	q0, [x19, #0x600]
1000a8f88: 3dc18661    	ldr	q1, [x19, #0x610]
1000a8f8c: ad1a0660    	stp	q0, q1, [x19, #0x340]
1000a8f90: 7953a3e8    	ldrh	w8, [sp, #0x9d0]
1000a8f94: 350001c8    	cbnz	w8, 0x1000a8fcc <_machine.convert.prepared+0x79c>
1000a8f98: 911c43e0    	add	x0, sp, #0x710
1000a8f9c: 910412e1    	add	x1, x23, #0x104
1000a8fa0: 911bc3e3    	add	x3, sp, #0x6f0
1000a8fa4: aa1503e2    	mov	x2, x21
1000a8fa8: 9400a7b9    	bl	0x1000d2e8c <_units.Plan.execute__func_1559>
1000a8fac: 794e63e8    	ldrh	w8, [sp, #0x730]
1000a8fb0: 350000e8    	cbnz	w8, 0x1000a8fcc <_machine.convert.prepared+0x79c>
1000a8fb4: ad5b0660    	ldp	q0, q1, [x19, #0x360]
1000a8fb8: ad1c8660    	stp	q0, q1, [x19, #0x390]
1000a8fbc: 911d03e8    	add	x8, sp, #0x740
1000a8fc0: 1400005c    	b	0x1000a9130 <_machine.convert.prepared+0x900>
1000a8fc4: 7100393f    	cmp	w9, #0xe
1000a8fc8: 54001262    	b.hs	0x1000a9214 <_machine.convert.prepared+0x9e4>
1000a8fcc: a9007f7f    	stp	xzr, xzr, [x27]
1000a8fd0: 17ffff0b    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a8fd4: eb1b039f    	cmp	x28, x27
1000a8fd8: 54001248    	b.hi	0x1000a9220 <_machine.convert.prepared+0x9f0>
1000a8fdc: 911583e0    	add	x0, sp, #0x560
1000a8fe0: aa1803e1    	mov	x1, x24
1000a8fe4: aa1c03e2    	mov	x2, x28
1000a8fe8: 97feae1a    	bl	0x100054850 <_decimal.decimal.Decimal.parse>
1000a8fec: 794b03e8    	ldrh	w8, [sp, #0x580]
1000a8ff0: 34000088    	cbz	w8, 0x1000a9000 <_machine.convert.prepared+0x7d0>
1000a8ff4: f94007e8    	ldr	x8, [sp, #0x8]
1000a8ff8: a9007d1f    	stp	xzr, xzr, [x8]
1000a8ffc: 17ffff00    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a9000: a95b667a    	ldp	x26, x25, [x19, #0x1b0]
1000a9004: cb1c0361    	sub	x1, x27, x28
1000a9008: b0000cc2    	adrp	x2, 0x100242000 <___anon_25295+0xb>
1000a900c: 912a3842    	add	x2, x2, #0xa8e
1000a9010: 8b1c0300    	add	x0, x24, x28
1000a9014: 52800023    	mov	w3, #0x1                ; =1
1000a9018: 9400a8ae    	bl	0x1000d32d0 <_mem.trim__func_1557>
1000a901c: b4000781    	cbz	x1, 0x1000a910c <_machine.convert.prepared+0x8dc>
1000a9020: aa0003e3    	mov	x3, x0
1000a9024: aa0103e4    	mov	x4, x1
1000a9028: 911643e0    	add	x0, sp, #0x590
1000a902c: 911583e2    	add	x2, sp, #0x560
1000a9030: aa1503e1    	mov	x1, x21
1000a9034: 97fe84cd    	bl	0x10004a368 <_units.Unit.parseQuantity>
1000a9038: 794c83e8    	ldrh	w8, [sp, #0x640]
1000a903c: 35fffdc8    	cbnz	w8, 0x1000a8ff4 <_machine.convert.prepared+0x7c4>
1000a9040: ad4f8660    	ldp	q0, q1, [x19, #0x1f0]
1000a9044: 3d806a60    	str	q0, [x19, #0x1a0]
1000a9048: ad528a60    	ldp	q0, q2, [x19, #0x250]
1000a904c: 3dc09e63    	ldr	q3, [x19, #0x270]
1000a9050: ad0b8e62    	stp	q2, q3, [x19, #0x170]
1000a9054: ad508e62    	ldp	q2, q3, [x19, #0x210]
1000a9058: ad519664    	ldp	q4, q5, [x19, #0x230]
1000a905c: ad099263    	stp	q3, q4, [x19, #0x130]
1000a9060: ad0a8265    	stp	q5, q0, [x19, #0x150]
1000a9064: a95e667a    	ldp	x26, x25, [x19, #0x1e0]
1000a9068: b94633e8    	ldr	w8, [sp, #0x630]
1000a906c: b90543e8    	str	w8, [sp, #0x540]
1000a9070: 911303f8    	add	x24, sp, #0x4c0
1000a9074: ad088a61    	stp	q1, q2, [x19, #0x110]
1000a9078: f94007fb    	ldr	x27, [sp, #0x8]
1000a907c: b5fff5f7    	cbnz	x23, 0x1000a8f38 <_machine.convert.prepared+0x708>
1000a9080: aa1803e0    	mov	x0, x24
1000a9084: aa1603e1    	mov	x1, x22
1000a9088: 97fe8223    	bl	0x100049914 <_units.Unit.compatible>
1000a908c: 3607fa00    	tbz	w0, #0x0, 0x1000a8fcc <_machine.convert.prepared+0x79c>
1000a9090: f901da7a    	str	x26, [x19, #0x3b0]
1000a9094: f901de79    	str	x25, [x19, #0x3b8]
1000a9098: 3dc06a60    	ldr	q0, [x19, #0x1a0]
1000a909c: 3d80f260    	str	q0, [x19, #0x3c0]
1000a90a0: 9126c3e0    	add	x0, sp, #0x9b0
1000a90a4: 911d83e3    	add	x3, sp, #0x760
1000a90a8: aa1803e1    	mov	x1, x24
1000a90ac: aa1503e2    	mov	x2, x21
1000a90b0: 52800004    	mov	w4, #0x0                ; =0
1000a90b4: 97fe88c4    	bl	0x10004b3c4 <_units.Unit.convert__func_913>
1000a90b8: 3dc18260    	ldr	q0, [x19, #0x600]
1000a90bc: 3dc18661    	ldr	q1, [x19, #0x610]
1000a90c0: ad1e8660    	stp	q0, q1, [x19, #0x3d0]
1000a90c4: 7953a3e8    	ldrh	w8, [sp, #0x9d0]
1000a90c8: 35fff828    	cbnz	w8, 0x1000a8fcc <_machine.convert.prepared+0x79c>
1000a90cc: 9126c3e0    	add	x0, sp, #0x9b0
1000a90d0: 911e03e3    	add	x3, sp, #0x780
1000a90d4: aa1603e1    	mov	x1, x22
1000a90d8: aa1503e2    	mov	x2, x21
1000a90dc: 52800024    	mov	w4, #0x1                ; =1
1000a90e0: 97fe88b9    	bl	0x10004b3c4 <_units.Unit.convert__func_913>
1000a90e4: 3dc18260    	ldr	q0, [x19, #0x600]
1000a90e8: 3dc18661    	ldr	q1, [x19, #0x610]
1000a90ec: ad1f8660    	stp	q0, q1, [x19, #0x3f0]
1000a90f0: 7953a3e8    	ldrh	w8, [sp, #0x9d0]
1000a90f4: 35fff6c8    	cbnz	w8, 0x1000a8fcc <_machine.convert.prepared+0x79c>
1000a90f8: ad5f8660    	ldp	q0, q1, [x19, #0x3f0]
1000a90fc: 3d810660    	str	q0, [x19, #0x410]
1000a9100: 3d810a61    	str	q1, [x19, #0x420]
1000a9104: 911f03e8    	add	x8, sp, #0x7c0
1000a9108: 1400000a    	b	0x1000a9130 <_machine.convert.prepared+0x900>
1000a910c: 911583e8    	add	x8, sp, #0x560
1000a9110: 91004108    	add	x8, x8, #0x10
1000a9114: f94007fb    	ldr	x27, [sp, #0x8]
1000a9118: 3dc00100    	ldr	q0, [x8]
1000a911c: 3d806a60    	str	q0, [x19, #0x1a0]
1000a9120: f9021a7a    	str	x26, [x19, #0x430]
1000a9124: f9021e79    	str	x25, [x19, #0x438]
1000a9128: 3d811260    	str	q0, [x19, #0x440]
1000a912c: 911f83e8    	add	x8, sp, #0x7e0
1000a9130: ad4202c1    	ldp	q1, q0, [x22, #0x40]
1000a9134: 3d813260    	str	q0, [x19, #0x4c0]
1000a9138: ad430ec2    	ldp	q2, q3, [x22, #0x60]
1000a913c: 3d813662    	str	q2, [x19, #0x4d0]
1000a9140: 3d813a63    	str	q3, [x19, #0x4e0]
1000a9144: b94082c9    	ldr	w9, [x22, #0x80]
1000a9148: b908a3e9    	str	w9, [sp, #0x8a0]
1000a914c: ad410ec2    	ldp	q2, q3, [x22, #0x20]
1000a9150: 3d812662    	str	q2, [x19, #0x490]
1000a9154: 3d812a63    	str	q3, [x19, #0x4a0]
1000a9158: ad400ac3    	ldp	q3, q2, [x22]
1000a915c: 3d812262    	str	q2, [x19, #0x480]
1000a9160: 3d812e61    	str	q1, [x19, #0x4b0]
1000a9164: 3d811e63    	str	q3, [x19, #0x470]
1000a9168: ad400d01    	ldp	q1, q3, [x8]
1000a916c: 3d811661    	str	q1, [x19, #0x450]
1000a9170: 3d811a63    	str	q3, [x19, #0x460]
1000a9174: 3d815e60    	str	q0, [x19, #0x570]
1000a9178: 3d814e62    	str	q2, [x19, #0x530]
1000a917c: 3dc13660    	ldr	q0, [x19, #0x4d0]
1000a9180: 3d816260    	str	q0, [x19, #0x580]
1000a9184: 3dc13a60    	ldr	q0, [x19, #0x4e0]
1000a9188: 3d816660    	str	q0, [x19, #0x590]
1000a918c: 3dc13e60    	ldr	q0, [x19, #0x4f0]
1000a9190: 3d816a60    	str	q0, [x19, #0x5a0]
1000a9194: 3dc12660    	ldr	q0, [x19, #0x490]
1000a9198: 3d815260    	str	q0, [x19, #0x540]
1000a919c: 3dc12a60    	ldr	q0, [x19, #0x4a0]
1000a91a0: 3d815660    	str	q0, [x19, #0x550]
1000a91a4: 3dc12e60    	ldr	q0, [x19, #0x4b0]
1000a91a8: 3d815a60    	str	q0, [x19, #0x560]
1000a91ac: 3d814261    	str	q1, [x19, #0x500]
1000a91b0: 3d814663    	str	q3, [x19, #0x510]
1000a91b4: 3dc11e60    	ldr	q0, [x19, #0x470]
1000a91b8: 3d814a60    	str	q0, [x19, #0x520]
1000a91bc: 52800068    	mov	w8, #0x3                ; =3
1000a91c0: b90963e8    	str	w8, [sp, #0x960]
1000a91c4: 9125e3e0    	add	x0, sp, #0x978
1000a91c8: 9122c3e2    	add	x2, sp, #0x8b0
1000a91cc: aa1403e1    	mov	x1, x20
1000a91d0: 97fe5c23    	bl	0x10004025c <_value.scalar>
1000a91d4: 795303e8    	ldrh	w8, [sp, #0x980]
1000a91d8: 35000148    	cbnz	w8, 0x1000a9200 <_machine.convert.prepared+0x9d0>
1000a91dc: f942e668    	ldr	x8, [x19, #0x5c8]
1000a91e0: f9000368    	str	x8, [x27]
1000a91e4: 7900137f    	strh	wzr, [x27, #0x8]
1000a91e8: 17fffe85    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a91ec: 79001388    	strh	w8, [x28, #0x8]
1000a91f0: 17fffe83    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a91f4: f94007e9    	ldr	x9, [sp, #0x8]
1000a91f8: 79001128    	strh	w8, [x9, #0x8]
1000a91fc: 17fffe80    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a9200: 79001368    	strh	w8, [x27, #0x8]
1000a9204: 17fffe7e    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a9208: 79001128    	strh	w8, [x9, #0x8]
1000a920c: 17fffe7c    	b	0x1000a8bfc <_machine.convert.prepared+0x3cc>
1000a9210: 94054e32    	bl	0x1001fcad8 <_writev+0x1001fcad8>
1000a9214: 94051304    	bl	0x1001ede24 <_debug.FullPanic((function 'defaultPanic')).corruptSwitch>
1000a9218: 94052a7d    	bl	0x1001f3c0c <_debug.FullPanic((function 'defaultPanic')).integerOverflow>
1000a921c: 940512de    	bl	0x1001edd94 <_debug.FullPanic((function 'defaultPanic')).memcpyAlias>
1000a9220: aa1c03e0    	mov	x0, x28
1000a9224: aa1b03e1    	mov	x1, x27
1000a9228: 94052a85    	bl	0x1001f3c3c <_debug.FullPanic((function 'defaultPanic')).outOfBounds>
