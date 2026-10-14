
compact experiment host:	file format mach-o arm64

Disassembly of section __TEXT,__text:

0000000100040510 <_value.scalar>:
100040510: d106c3ff    	sub	sp, sp, #0x1b0
100040514: a9156ffc    	stp	x28, x27, [sp, #0x150]
100040518: a91667fa    	stp	x26, x25, [sp, #0x160]
10004051c: a9175ff8    	stp	x24, x23, [sp, #0x170]
100040520: a91857f6    	stp	x22, x21, [sp, #0x180]
100040524: a9194ff4    	stp	x20, x19, [sp, #0x190]
100040528: a91a7bfd    	stp	x29, x30, [sp, #0x1a0]
10004052c: 910683fd    	add	x29, sp, #0x1a0
100040530: aa0203f5    	mov	x21, x2
100040534: aa0103f4    	mov	x20, x1
100040538: aa0003f3    	mov	x19, x0
10004053c: b0001328    	adrp	x8, 0x1002a5000 <___anon_137366+0x38>
100040540: f9470908    	ldr	x8, [x8, #0xe10]
100040544: f9400108    	ldr	x8, [x8]
100040548: f81a03a8    	stur	x8, [x29, #-0x60]
10004054c: a9407036    	ldp	x22, x28, [x1]
100040550: b9412048    	ldr	w8, [x2, #0x120]
100040554: 71001d1f    	cmp	w8, #0x7
100040558: 5400020c    	b.gt	0x100040598 <_value.scalar+0x88>
10004055c: 7100191f    	cmp	w8, #0x6
100040560: 54000360    	b.eq	0x1000405cc <_value.scalar+0xbc>
100040564: 71001d1f    	cmp	w8, #0x7
100040568: 540002a1    	b.ne	0x1000405bc <_value.scalar+0xac>
10004056c: f94006a9    	ldr	x9, [x21, #0x8]
100040570: b4000509    	cbz	x9, 0x100040610 <_value.scalar+0x100>
100040574: d2800008    	mov	x8, #0x0                ; =0
100040578: f94002aa    	ldr	x10, [x21]
10004057c: 9100414a    	add	x10, x10, #0x10
100040580: f841854b    	ldr	x11, [x10], #0x18
100040584: f940356b    	ldr	x11, [x11, #0x68]
100040588: 9acb6508    	umax	x8, x8, x11
10004058c: f1000529    	subs	x9, x9, #0x1
100040590: 54ffff81    	b.ne	0x100040580 <_value.scalar+0x70>
100040594: 14000020    	b	0x100040614 <_value.scalar+0x104>
100040598: 7100211f    	cmp	w8, #0x8
10004059c: 540002c0    	b.eq	0x1000405f4 <_value.scalar+0xe4>
1000405a0: 7100311f    	cmp	w8, #0xc
1000405a4: 540000c1    	b.ne	0x1000405bc <_value.scalar+0xac>
1000405a8: f94016a8    	ldr	x8, [x21, #0x28]
1000405ac: f9403508    	ldr	x8, [x8, #0x68]
1000405b0: b100051a    	adds	x26, x8, #0x1
1000405b4: 54000343    	b.lo	0x10004061c <_value.scalar+0x10c>
1000405b8: 14000082    	b	0x1000407c0 <_value.scalar+0x2b0>
1000405bc: 7100391f    	cmp	w8, #0xe
1000405c0: 54001262    	b.hs	0x10004080c <_value.scalar+0x2fc>
1000405c4: d280001a    	mov	x26, #0x0               ; =0
1000405c8: 14000015    	b	0x10004061c <_value.scalar+0x10c>
1000405cc: f94006a9    	ldr	x9, [x21, #0x8]
1000405d0: b40005c9    	cbz	x9, 0x100040688 <_value.scalar+0x178>
1000405d4: d2800008    	mov	x8, #0x0                ; =0
1000405d8: f94002aa    	ldr	x10, [x21]
1000405dc: f840854b    	ldr	x11, [x10], #0x8
1000405e0: f940356b    	ldr	x11, [x11, #0x68]
1000405e4: 9acb6508    	umax	x8, x8, x11
1000405e8: f1000529    	subs	x9, x9, #0x1
1000405ec: 54ffff81    	b.ne	0x1000405dc <_value.scalar+0xcc>
1000405f0: 14000009    	b	0x100040614 <_value.scalar+0x104>
1000405f4: a94026a8    	ldp	x8, x9, [x21]
1000405f8: f9403508    	ldr	x8, [x8, #0x68]
1000405fc: f9403529    	ldr	x9, [x9, #0x68]
100040600: 9ac96508    	umax	x8, x8, x9
100040604: b100051a    	adds	x26, x8, #0x1
100040608: 540000a3    	b.lo	0x10004061c <_value.scalar+0x10c>
10004060c: 1400006d    	b	0x1000407c0 <_value.scalar+0x2b0>
100040610: d2800008    	mov	x8, #0x0                ; =0
100040614: b100051a    	adds	x26, x8, #0x1
100040618: 54000d42    	b.hs	0x1000407c0 <_value.scalar+0x2b0>
10004061c: dac143fe    	xpaci	x30
100040620: f9400388    	ldr	x8, [x28]
100040624: aa1603e0    	mov	x0, x22
100040628: 52801001    	mov	w1, #0x80               ; =128
10004062c: 52800082    	mov	w2, #0x4                ; =4
100040630: aa1e03f9    	mov	x25, x30
100040634: aa1e03e3    	mov	x3, x30
100040638: d63f0100    	blr	x8
10004063c: b4000c20    	cbz	x0, 0x1000407c0 <_value.scalar+0x2b0>
100040640: 4f05e540    	movi.16b	v0, #0xaa
100040644: ad030000    	stp	q0, q0, [x0, #0x60]
100040648: ad020000    	stp	q0, q0, [x0, #0x40]
10004064c: ad010000    	stp	q0, q0, [x0, #0x20]
100040650: ad000000    	stp	q0, q0, [x0]
100040654: f2400c1f    	tst	x0, #0xf
100040658: 54000d61    	b.ne	0x100040804 <_value.scalar+0x2f4>
10004065c: b94122bb    	ldr	w27, [x21, #0x120]
100040660: 7100377f    	cmp	w27, #0xd
100040664: 54000d28    	b.hi	0x100040808 <_value.scalar+0x2f8>
100040668: b0000de8    	adrp	x8, 0x1001fd000 <_writev+0x1001fd000>
10004066c: 911c0108    	add	x8, x8, #0x700
100040670: 10000089    	adr	x9, 0x100040680 <_value.scalar+0x170>
100040674: 387b690a    	ldrb	w10, [x8, x27]
100040678: 8b0a0929    	add	x9, x9, x10, lsl #2
10004067c: d61f0120    	br	x9
100040680: a94022b7    	ldp	x23, x8, [x21]
100040684: 14000038    	b	0x100040764 <_value.scalar+0x254>
100040688: d2800008    	mov	x8, #0x0                ; =0
10004068c: b100051a    	adds	x26, x8, #0x1
100040690: 54fffc63    	b.lo	0x10004061c <_value.scalar+0x10c>
100040694: 1400004b    	b	0x1000407c0 <_value.scalar+0x2b0>
100040698: a94022b7    	ldp	x23, x8, [x21]
10004069c: 3dc006a0    	ldr	q0, [x21, #0x10]
1000406a0: 3d8003e0    	str	q0, [sp]
1000406a4: 14000030    	b	0x100040764 <_value.scalar+0x254>
1000406a8: a94022b7    	ldp	x23, x8, [x21]
1000406ac: ad4086a0    	ldp	q0, q1, [x21, #0x10]
1000406b0: ad0007e0    	stp	q0, q1, [sp]
1000406b4: 1400002c    	b	0x100040764 <_value.scalar+0x254>
1000406b8: aa0003f8    	mov	x24, x0
1000406bc: 910083e0    	add	x0, sp, #0x20
1000406c0: aa1503e1    	mov	x1, x21
1000406c4: 52802402    	mov	w2, #0x120              ; =288
1000406c8: 9406edeb    	bl	0x1001fbe74 <_writev+0x1001fbe74>
1000406cc: f9400388    	ldr	x8, [x28]
1000406d0: aa1603e0    	mov	x0, x22
1000406d4: 52802401    	mov	w1, #0x120              ; =288
1000406d8: 52800082    	mov	w2, #0x4                ; =4
1000406dc: aa1903e3    	mov	x3, x25
1000406e0: d63f0100    	blr	x8
1000406e4: b4000600    	cbz	x0, 0x1000407a4 <_value.scalar+0x294>
1000406e8: aa0003f7    	mov	x23, x0
1000406ec: 4f05e540    	movi.16b	v0, #0xaa
1000406f0: ad080000    	stp	q0, q0, [x0, #0x100]
1000406f4: ad070000    	stp	q0, q0, [x0, #0xe0]
1000406f8: ad060000    	stp	q0, q0, [x0, #0xc0]
1000406fc: ad050000    	stp	q0, q0, [x0, #0xa0]
100040700: ad040000    	stp	q0, q0, [x0, #0x80]
100040704: ad030000    	stp	q0, q0, [x0, #0x60]
100040708: ad020000    	stp	q0, q0, [x0, #0x40]
10004070c: ad010000    	stp	q0, q0, [x0, #0x20]
100040710: ad000000    	stp	q0, q0, [x0]
100040714: f2400c1f    	tst	x0, #0xf
100040718: 54000761    	b.ne	0x100040804 <_value.scalar+0x2f4>
10004071c: 910083e1    	add	x1, sp, #0x20
100040720: aa1703e0    	mov	x0, x23
100040724: 52802402    	mov	w2, #0x120              ; =288
100040728: 9406edd3    	bl	0x1001fbe74 <_writev+0x1001fbe74>
10004072c: aa1803e0    	mov	x0, x24
100040730: 1400000d    	b	0x100040764 <_value.scalar+0x254>
100040734: d2800008    	mov	x8, #0x0                ; =0
100040738: 6f00e400    	movi.2d	v0, #0000000000000000
10004073c: ad0003e0    	stp	q0, q0, [sp]
100040740: 14000009    	b	0x100040764 <_value.scalar+0x254>
100040744: 394002a8    	ldrb	w8, [x21]
100040748: 92400117    	and	x23, x8, #0x1
10004074c: 14000006    	b	0x100040764 <_value.scalar+0x254>
100040750: a94022b7    	ldp	x23, x8, [x21]
100040754: 3dc006a0    	ldr	q0, [x21, #0x10]
100040758: 3d8003e0    	str	q0, [sp]
10004075c: f94012a9    	ldr	x9, [x21, #0x20]
100040760: f9000be9    	str	x9, [sp, #0x10]
100040764: 52800009    	mov	w9, #0x0                ; =0
100040768: 3dc00280    	ldr	q0, [x20]
10004076c: 3c848000    	stur	q0, [x0, #0x48]
100040770: a9002017    	stp	x23, x8, [x0]
100040774: ad4007e0    	ldp	q0, q1, [sp]
100040778: ad008400    	stp	q0, q1, [x0, #0x10]
10004077c: b900301b    	str	w27, [x0, #0x30]
100040780: f803401f    	stur	xzr, [x0, #0x34]
100040784: b9003c1f    	str	wzr, [x0, #0x3c]
100040788: 52800028    	mov	w8, #0x1                ; =1
10004078c: f9002008    	str	x8, [x0, #0x40]
100040790: 7900f01f    	strh	wzr, [x0, #0x78]
100040794: a906fc1a    	stp	x26, xzr, [x0, #0x68]
100040798: a905fc1f    	stp	xzr, xzr, [x0, #0x58]
10004079c: f9000260    	str	x0, [x19]
1000407a0: 14000009    	b	0x1000407c4 <_value.scalar+0x2b4>
1000407a4: f9400f88    	ldr	x8, [x28, #0x18]
1000407a8: aa1603e0    	mov	x0, x22
1000407ac: aa1803e1    	mov	x1, x24
1000407b0: 52801002    	mov	w2, #0x80               ; =128
1000407b4: 52800083    	mov	w3, #0x4                ; =4
1000407b8: aa1903e4    	mov	x4, x25
1000407bc: d63f0100    	blr	x8
1000407c0: 528000a9    	mov	w9, #0x5                ; =5
1000407c4: 79001269    	strh	w9, [x19, #0x8]
1000407c8: f85a03a8    	ldur	x8, [x29, #-0x60]
1000407cc: b0001329    	adrp	x9, 0x1002a5000 <___anon_137366+0x38>
1000407d0: f9470929    	ldr	x9, [x9, #0xe10]
1000407d4: f9400129    	ldr	x9, [x9]
1000407d8: eb08013f    	cmp	x9, x8
1000407dc: 54000121    	b.ne	0x100040800 <_value.scalar+0x2f0>
1000407e0: a95a7bfd    	ldp	x29, x30, [sp, #0x1a0]
1000407e4: a9594ff4    	ldp	x20, x19, [sp, #0x190]
1000407e8: a95857f6    	ldp	x22, x21, [sp, #0x180]
1000407ec: a9575ff8    	ldp	x24, x23, [sp, #0x170]
1000407f0: a95667fa    	ldp	x26, x25, [sp, #0x160]
1000407f4: a9556ffc    	ldp	x28, x27, [sp, #0x150]
1000407f8: 9106c3ff    	add	sp, sp, #0x1b0
1000407fc: d65f03c0    	ret
100040800: 9406ecf8    	bl	0x1001fbbe0 <_writev+0x1001fbbe0>
100040804: 9406b2b3    	bl	0x1001ed2d0 <_debug.FullPanic((function 'defaultPanic')).incorrectAlignment>
100040808: 71003b7f    	cmp	w27, #0xe
10004080c: 9406b1a6    	bl	0x1001ecea4 <_debug.FullPanic((function 'defaultPanic')).corruptSwitch>
